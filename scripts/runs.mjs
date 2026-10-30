// Per-run locks shared by Claude Code and Codex. Each active run owns .model-ladder/runs/<runId>.json:
//   { runId, runtime, pid, startedAt, protected, tests, scope, readOnly }
// scope is null until the router's scope is claimed; then a list of repo-relative paths or globs.
// pid is the long-lived process that holds the run (the Codex runner). Claude Code runs record null:
// its scripts exit between steps, so liveness is unknown and the lock counts as active until finish.
// The legacy single lock .model-ladder/run.json (older versions) is read as one more run with unknown scope.
// Only node built-ins here: hooks/guard.mjs imports this file.
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const runsDir = (root) => join(root, '.model-ladder', 'runs')
export const legacyLock = (root) => join(root, '.model-ladder', 'run.json')
export const lockPath = (root, runId) => join(runsDir(root), `${runId}.json`)

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

// Every lock on disk, own included. A lock is stale when its pid is dead, when it cannot be read, or
// when it is a legacy run.json without a pid (an older Claude Code run: active or crashed, ask).
export function readLocks(root) {
  const files = [{ path: legacyLock(root), legacy: true }]
  try {
    for (const name of readdirSync(runsDir(root))) if (name.endsWith('.json')) files.push({ path: join(runsDir(root), name), legacy: false })
  } catch {}
  const locks = []
  for (const { path, legacy } of files) {
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    let data
    try { data = JSON.parse(text) } catch { data = null }
    const fileId = legacy ? 'run.json' : path.split(/[\\/]/).pop().slice(0, -'.json'.length)
    if (!data || typeof data !== 'object') {
      locks.push({ path, legacy, runId: fileId, runtime: 'unknown', pid: null, protected: [], tests: [], scope: ['**'], readOnly: false, stale: true })
      continue
    }
    const live = alive(data.pid)
    locks.push({
      ...data,
      path,
      legacy,
      runId: typeof data.runId === 'string' ? data.runId : fileId,
      protected: Array.isArray(data.protected) ? data.protected : [],
      tests: Array.isArray(data.tests) ? data.tests : [],
      // A legacy run never claims a scope, so it may touch anything.
      scope: legacy ? ['**'] : Array.isArray(data.scope) ? data.scope : null,
      readOnly: !legacy && data.readOnly === true,
      stale: live === false || legacy && live === null,
    })
  }
  return locks
}

// Written whole through a rename, so a reader never sees half a lock.
// On Windows the rename fails while another process has the target open (a guard reading it); retry briefly.
function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  for (let tries = 0; ; tries++) {
    try { renameSync(tmp, path); return } catch (error) {
      if (tries >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { rmSync(tmp, { force: true }); throw error }
      sleep(50)
    }
  }
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function createLock(root, lock) {
  mkdirSync(runsDir(root), { recursive: true })
  const value = { scope: null, readOnly: false, startedAt: new Date().toISOString(), ...lock }
  writeAtomic(lockPath(root, lock.runId), value)
  return value
}

export function releaseLock(root, runId) {
  rmSync(lockPath(root, runId), { force: true })
}

// Removes the stale locks (and the one named by `force`, unless its process is alive). Returns what it removed.
export function clearStale(root, { force = null, exclude = null } = {}) {
  const removed = []
  for (const lock of readLocks(root)) {
    if (lock.runId === exclude) continue
    if (lock.stale || force && lock.runId === force && alive(lock.pid) !== true) {
      rmSync(lock.path, { force: true })
      removed.push(lock.runId)
    }
  }
  return removed
}

// --clear-stale -> true; --clear-stale=<runId> -> that runId (also cleared unless its process is alive); else false.
export function clearStaleFlag(flags) {
  const named = [...flags].find((flag) => flag.startsWith('--clear-stale='))
  return named ? named.slice('--clear-stale='.length) : flags.has('--clear-stale')
}

const GLOB = /[*?[{]/
const norm = (entry) => String(entry).replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').toLowerCase()
// The literal directory part of an entry: a literal path stands for itself and everything under it;
// a glob for everything under the directory before its first wildcard.
function base(entry) {
  const at = entry.search(GLOB)
  if (at < 0) return entry
  const cut = entry.lastIndexOf('/', at)
  return cut < 0 ? '' : entry.slice(0, cut)
}
const within = (a, b) => b === '' || a === b || a.startsWith(`${b}/`)

// Unknown or unbounded scope counts as everything: empty, a bare wildcard, or a path leaving the repo.
export function normalizeScope(scope) {
  const list = (Array.isArray(scope) ? scope : []).map(norm).filter((entry) => entry !== '.')
  if (!list.length || list.some((entry) => entry === '' || entry.startsWith('/') || /^[a-z]:/.test(entry) || entry.split('/').includes('..'))) return ['**']
  return list
}

// Conservative: two entries overlap when one's base directory contains the other's.
export function scopesOverlap(a, b) {
  const left = normalizeScope(a).map(base)
  const right = normalizeScope(b).map(base)
  return left.some((x) => right.some((y) => within(x, y) || within(y, x)))
}

// Claims the router's scope for runId. Serialized by the registry mutex, so two runs never both pass
// against each other. Unclaimed locks are skipped: they compare against this one when they claim.
//   READY        scope recorded; the run may proceed
//   STALE_RUN    an overlapping run is stale (dead process, unreadable or legacy lock) -> clearStale
//   NEEDS_INPUT  an overlapping run is active -> wait for it and claim again
export function claimScope(root, runId, { scope, readOnly = false, clear = false, force = null } = {}) {
  return withMutex(root, 'registry', () => {
    if (clear || force) clearStale(root, { force, exclude: runId })
    const locks = readLocks(root)
    const own = locks.find((lock) => !lock.legacy && lock.runId === runId)
    if (!own) return { status: 'ERROR', message: `The lock for run ${runId} is gone (cleared as stale?). Start the run again.` }
    const claimed = readOnly ? [] : normalizeScope(scope)
    const overlaps = readOnly ? [] : locks.filter((lock) => lock !== own && !lock.readOnly && lock.scope && scopesOverlap(claimed, lock.scope))
    const describe = (lock) => ({ runId: lock.runId, runtime: lock.runtime ?? 'unknown', startedAt: lock.startedAt ?? null, scope: lock.scope, stale: lock.stale, lock: lock.path })
    const stale = overlaps.filter((lock) => lock.stale)
    if (stale.length) {
      return { status: 'STALE_RUN', message: `This run's scope overlaps runs whose lock looks stale (process gone, unreadable, or an older version's run.json): ${stale.map((l) => l.runId).join(', ')}. Clear them only if they are not running.`, overlaps: overlaps.map(describe) }
    }
    if (overlaps.length) {
      const list = overlaps.map((l) => `${l.runId} (${l.runtime ?? 'unknown'}${l.startedAt ? `, started ${l.startedAt}` : ''}): ${l.scope.join(', ')}`).join('; ')
      return {
        status: 'NEEDS_INPUT',
        reason: 'OVERLAP',
        message: `This run's scope (${claimed.join(', ')}) overlaps another active model-ladder run: ${list}. Wait for it to finish and claim again, or stop. If a listed run is no longer running, clear its lock by run ID.`,
        overlaps: overlaps.map(describe),
      }
    }
    const { path, legacy, stale: _, ...data } = own
    writeAtomic(path, { ...data, scope: claimed, readOnly })
    return { status: 'READY', scope: claimed }
  })
}

// A cross-process mutex: an exclusive file holding its owner's pid. A dead owner's file is taken over;
// a live owner is waited for up to timeoutMs. Used for scope claims ('registry') and for writing results
// into the user's checkout ('apply'), so two runs never apply or snapshot at the same time.
export function withMutex(root, name, fn, { timeoutMs = 300000 } = {}) {
  mkdirSync(runsDir(root), { recursive: true })
  const path = join(runsDir(root), `${name}.lock`)
  const owner = JSON.stringify({ pid: process.pid, id: randomUUID() })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(path, 'wx')
      try { writeSync(fd, owner) } finally { closeSync(fd) }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let text = null
    try { text = readFileSync(path, 'utf8') } catch {}
    let pid = null
    try { pid = JSON.parse(text).pid } catch {}
    // An empty file is a holder between open and write; give it a moment before treating it as dead.
    const young = (() => { try { return Date.now() - statSync(path).mtimeMs < 2000 } catch { return true } })()
    if (text !== null && (alive(pid) === false || pid === null && !young)) {
      const tomb = `${path}.${process.pid}.${randomUUID()}.stale`
      try {
        renameSync(path, tomb)
        // Took a fresh holder's file by mistake: put it back.
        if (readFileSync(tomb, 'utf8') !== text) { try { linkSync(tomb, path) } catch {} }
        rmSync(tomb, { force: true })
      } catch {}
      continue
    }
    if (Date.now() > deadline) throw new Error(`model-ladder: timed out waiting for ${path}; another run holds it. Delete it if no run is applying.`)
    sleep(50)
  }
  try {
    return fn()
  } finally {
    try { if (readFileSync(path, 'utf8') === owner) rmSync(path, { force: true }) } catch {}
  }
}

// Protection every active run asks for, merged: a worker obeys the strictest union.
export function mergedProtection(root) {
  const locks = readLocks(root)
  return {
    active: locks.length > 0,
    protected: [...new Set(locks.flatMap((lock) => lock.protected))],
    tests: [...new Set(locks.flatMap((lock) => lock.tests))],
  }
}
