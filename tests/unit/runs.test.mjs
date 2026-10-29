import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { artifactDir, pruneRuns } from '../../scripts/common.mjs'
import { snapshot } from '../../scripts/codex-worktree.mjs'
import { claimScope, clearStale, createLock, lockPath, readLocks, releaseLock, runsDir, scopesOverlap, withMutex } from '../../scripts/runs.mjs'

const dirs = []
after(() => dirs.forEach((d) => {
  rmSync(artifactDir(d), { recursive: true, force: true })
  rmSync(d, { recursive: true, force: true })
}))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (dir, file, text) => {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-runs-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'core.autocrlf', 'false')
  write(dir, '.gitignore', '.model-ladder/\n')
  write(dir, 'a.py', 'a = 1\n')
  write(dir, 'b.py', 'b = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}
// The pid of a process that has already exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
const lock = (runId, extra = {}) => ({ runId, runtime: 'claude', pid: null, protected: ['.claude/model-ladder.json'], tests: ['**/tests/**'], ...extra })

test('scope overlap: same file, a file inside a claimed directory or glob, and unknown scope', () => {
  assert.ok(scopesOverlap(['src/a.js'], ['src/a.js']))
  assert.ok(scopesOverlap(['src/a.js'], ['./src/A.js']), 'case and ./ do not hide an overlap')
  assert.ok(scopesOverlap(['src'], ['src/deep/a.js']))
  assert.ok(scopesOverlap(['src/**/*.ts'], ['src/x/y.ts']))
  assert.ok(scopesOverlap(['src\\win.js'], ['src/win.js']))
  for (const broad of [[], ['**'], ['*'], ['.'], ['../outside.js'], ['/abs/a.js']]) assert.ok(scopesOverlap(broad, ['docs/x.md']), JSON.stringify(broad))
  assert.ok(!scopesOverlap(['src/a.js'], ['src/b.js']))
  assert.ok(!scopesOverlap(['scripts/a.mjs', 'README.md'], ['hooks/guard.mjs', 'docs/**']))
  assert.ok(!scopesOverlap(['src/ab'], ['src/a']), 'a name prefix is not a directory')
})

test('two runs with separate scopes both claim and run at the same time', () => {
  const dir = repo()
  createLock(dir, lock('claude-a'))
  createLock(dir, lock('codex-b', { runtime: 'codex', pid: process.pid }))
  assert.equal(claimScope(dir, 'claude-a', { scope: ['a.py'] }).status, 'READY')
  assert.equal(claimScope(dir, 'codex-b', { scope: ['b.py'] }).status, 'READY')
  const byId = Object.fromEntries(readLocks(dir).map((l) => [l.runId, l]))
  assert.deepEqual(byId['claude-a'].scope, ['a.py'])
  assert.deepEqual(byId['codex-b'].scope, ['b.py'])
})

test('an overlapping run is told to wait, and the active run keeps its lock', () => {
  const dir = repo()
  createLock(dir, lock('claude-a'))
  createLock(dir, lock('claude-b'))
  assert.equal(claimScope(dir, 'claude-a', { scope: ['a.py', 'lib/**'] }).status, 'READY')
  const blocked = claimScope(dir, 'claude-b', { scope: ['lib/x.py'] })
  assert.equal(blocked.status, 'NEEDS_INPUT')
  assert.equal(blocked.reason, 'OVERLAP')
  assert.deepEqual(blocked.overlaps.map((o) => o.runId), ['claude-a'])
  assert.match(blocked.message, /claude-a/)
  const byId = Object.fromEntries(readLocks(dir).map((l) => [l.runId, l]))
  assert.equal(byId['claude-b'].scope, null, 'a blocked run claims nothing')
  assert.deepEqual(byId['claude-a'].scope, ['a.py', 'lib/**'])
  // Once the first run is done, the second claims.
  releaseLock(dir, 'claude-a')
  assert.equal(claimScope(dir, 'claude-b', { scope: ['lib/x.py'] }).status, 'READY')
})

test('unknown scope overlaps any active run; read-only runs and unclaimed runs never block', () => {
  const dir = repo()
  createLock(dir, lock('claude-a'))
  createLock(dir, lock('claude-b'))
  createLock(dir, lock('claude-c'))
  assert.equal(claimScope(dir, 'claude-a', { scope: [] }).status, 'READY', 'alone, an unknown scope runs')
  assert.deepEqual(readLocks(dir).find((l) => l.runId === 'claude-a').scope, ['**'])
  assert.equal(claimScope(dir, 'claude-b', { scope: ['b.py'] }).status, 'NEEDS_INPUT')
  assert.equal(claimScope(dir, 'claude-c', { scope: [], readOnly: true }).status, 'READY')
  releaseLock(dir, 'claude-a')
  // claude-b is unclaimed (it was blocked), so it does not hold anything yet.
  assert.equal(claimScope(dir, 'claude-c', { scope: ['b.py'] }).status, 'READY')
})

test('stale locks: a dead pid or a legacy run.json is STALE_RUN and is cleared per lock', () => {
  const dir = repo()
  createLock(dir, lock('claude-live'))
  createLock(dir, lock('codex-live', { runtime: 'codex', pid: process.pid, scope: ['b.py'] }))
  createLock(dir, lock('codex-dead', { runtime: 'codex', pid: deadPid(), scope: ['a.py'] }))
  write(dir, '.model-ladder/run.json', JSON.stringify({ protected: [], tests: [] }))
  const stale = readLocks(dir).filter((l) => l.stale).map((l) => l.runId).sort()
  assert.deepEqual(stale, ['codex-dead', 'run.json'])
  const asked = claimScope(dir, 'claude-live', { scope: ['a.py'] })
  assert.equal(asked.status, 'STALE_RUN')
  assert.ok(existsSync(lockPath(dir, 'codex-dead')), 'never cleared without consent')
  assert.equal(claimScope(dir, 'claude-live', { scope: ['a.py'], clear: true }).status, 'READY')
  assert.ok(!existsSync(lockPath(dir, 'codex-dead')))
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  assert.ok(existsSync(lockPath(dir, 'codex-live')), 'a live run keeps its lock')
})

test('a named lock is cleared on request, unless its process is alive', () => {
  const dir = repo()
  createLock(dir, lock('claude-gone', { scope: ['a.py'] }))
  createLock(dir, lock('codex-live', { runtime: 'codex', pid: process.pid, scope: ['b.py'] }))
  assert.deepEqual(clearStale(dir, { force: 'codex-live' }), [])
  assert.deepEqual(clearStale(dir, { force: 'claude-gone' }), ['claude-gone'])
  assert.deepEqual(readLocks(dir).map((l) => l.runId), ['codex-live'])
})

test('a live legacy run.json (older Codex runner) counts as an active run over the whole repo', () => {
  const dir = repo()
  write(dir, '.model-ladder/run.json', JSON.stringify({ runtime: 'codex', runId: 'codex-old', pid: process.pid, protected: [], tests: [] }))
  createLock(dir, lock('claude-a'))
  const out = claimScope(dir, 'claude-a', { scope: ['a.py'] })
  assert.equal(out.status, 'NEEDS_INPUT')
  assert.deepEqual(out.overlaps.map((o) => o.runId), ['codex-old'])
})

test('pruneRuns leaves the artifacts of runs that still hold a lock', () => {
  const dir = repo()
  const finished = (id) => {
    const path = join(artifactDir(dir), id)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'result.json'), JSON.stringify({ status: 'VERIFIED' }))
    return path
  }
  const active = 'codex-00000000-0000-0000-0000-000000000001'
  const resumed = 'codex-00000000-0000-0000-0000-000000000002'
  const done = 'codex-00000000-0000-0000-0000-000000000003'
  const paths = [active, resumed, done].map(finished)
  createLock(dir, lock(active, { runtime: 'codex', pid: process.pid, resumeRun: resumed }))
  assert.deepEqual(pruneRuns(dir), [done])
  assert.ok(existsSync(paths[0]) && existsSync(paths[1]) && !existsSync(paths[2]))
  releaseLock(dir, active)
  assert.deepEqual(pruneRuns(dir).sort(), [active, resumed])
})

test('pruneRuns also cleans finished legacy runs in .model-ladder, with the same keep rules', () => {
  const dir = repo()
  const id = (n) => `codex-00000000-0000-4000-8000-00000000000${n}`
  const make = (n, result, extra = {}) => {
    write(dir, `.model-ladder/${id(n)}/events.jsonl`, '')
    if (result) write(dir, `.model-ladder/${id(n)}/result.json`, JSON.stringify(result))
    for (const [file, value] of Object.entries(extra)) write(dir, `.model-ladder/${id(n)}/${file}`, value)
  }
  make(1, { status: 'VERIFIED' })
  make(2, { status: 'FAILED' })
  git(dir, 'worktree', 'add', '--detach', '-q', join(dir, '.model-ladder', id(2), 'attempt-1'), 'HEAD')
  make(3, { status: 'CONFLICT' })
  make(4, { status: 'STOPPED' }, { 'checkpoint.json': '{}' })
  make(5, null)
  make(6, { status: 'VERIFIED' }, { 'result.patch': 'diff' })
  make(7, { status: 'VERIFIED' })
  createLock(dir, lock(id(7), { runtime: 'codex', pid: process.pid }))
  write(dir, '.model-ladder/history.jsonl', '')
  assert.deepEqual(pruneRuns(dir).sort(), [id(1), id(2)])
  assert.deepEqual(readdirSync(join(dir, '.model-ladder')).filter((f) => f.startsWith('codex-')).sort(), [3, 4, 5, 6, 7].map(id))
  assert.ok(existsSync(join(dir, '.model-ladder/history.jsonl')) && existsSync(runsDir(dir)), 'shared files stay')
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1, 'the legacy attempt worktree is unregistered')
})

test('pruneRuns with keepFailed keeps a legacy run that still has an attempt worktree', () => {
  const dir = repo()
  const id = 'codex-00000000-0000-4000-8000-000000000001'
  write(dir, `.model-ladder/${id}/result.json`, JSON.stringify({ status: 'FAILED' }))
  git(dir, 'worktree', 'add', '--detach', '-q', join(dir, '.model-ladder', id, 'attempt-1'), 'HEAD')
  assert.deepEqual(pruneRuns(dir, { keepFailed: true }), [])
  assert.ok(existsSync(join(dir, '.model-ladder', id, 'attempt-1')))
  assert.deepEqual(pruneRuns(dir), [id])
  assert.ok(!existsSync(join(dir, '.model-ladder', id)))
})

test('the mutex takes over from a dead holder', () => {
  const dir = repo()
  mkdirSync(runsDir(dir), { recursive: true })
  writeFileSync(join(runsDir(dir), 'apply.lock'), JSON.stringify({ pid: deadPid(), id: 'x' }))
  assert.equal(withMutex(dir, 'apply', () => 'ran', { timeoutMs: 2000 }), 'ran')
  assert.ok(!existsSync(join(runsDir(dir), 'apply.lock')), 'released after use')
})

test('applies are serialized: a second run waits for the apply lock, then applies', async () => {
  const dir = repo()
  write(dir, 'a.py', 'a = 2\n')
  const run = mkdtempSync(join(tmpdir(), 'ml-runs-art-'))
  dirs.push(run)
  const resultTree = snapshot(dir, run, 'result')
  git(dir, 'checkout', '--', 'a.py')
  const baseTree = git(dir, 'rev-parse', 'HEAD^{tree}')
  const baseCommit = git(dir, 'rev-parse', 'HEAD')
  // This process holds the apply lock, as a run in the middle of its apply would.
  mkdirSync(runsDir(dir), { recursive: true })
  const held = join(runsDir(dir), 'apply.lock')
  writeFileSync(held, JSON.stringify({ pid: process.pid, id: 'holder' }))
  const module = new URL('../../scripts/codex-worktree.mjs', import.meta.url).href
  const code = `import { applyResult } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(applyResult(...JSON.parse(process.argv[1]))))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([dir, run, baseTree, resultTree, baseCommit])], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(child.exitCode, null, 'still waiting for the lock')
  assert.equal(readFileSync(join(dir, 'a.py'), 'utf8'), 'a = 1\n', 'nothing written while another run applies')
  rmSync(held)
  assert.equal(await exited, 0)
  assert.equal(JSON.parse(out).applied, true)
  assert.equal(readFileSync(join(dir, 'a.py'), 'utf8'), 'a = 2\n')
  assert.ok(!existsSync(held))
})
