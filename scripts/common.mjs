import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { canonical } from '../hooks/guard.mjs'
import { readLocks } from './runs.mjs'

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
export const tryGit = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) }
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) }
  }
}

// Keeps run artifacts out of git without touching the user's .gitignore: appends missing patterns to
// <git dir>/info/exclude (worktree and submodule safe). Idempotent; never throws.
export const EXCLUDE_LINES = ['.model-ladder/', '.claude/worktrees/']
export function ensureGitExclude(cwd = process.cwd()) {
  try {
    const rel = git(cwd, 'rev-parse', '--git-path', 'info/exclude')
    const file = isAbsolute(rel) ? rel : resolve(cwd, rel)
    const have = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines = new Set(have.split(/\r?\n/).map((l) => l.trim()))
    const missing = EXCLUDE_LINES.filter((line) => !lines.has(line) && !tryGit(cwd, 'check-ignore', '-q', `${line}x`).ok)
    if (!missing.length) return
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
  } catch {}
}

export const repoRoot = () => git(process.cwd(), 'rev-parse', '--show-toplevel')
// Run files live outside .git and .claude: Claude Code asks permission to change files in both.
// Only small shared files stay here: runs/ (one lock per active run, see runs.mjs), history.jsonl,
// HANDOFF.md, live.json, usage.json.
export const runDir = (root) => join(root, '.model-ladder')
// Per-run artifacts (Codex attempt worktrees, logs, snapshots, checkpoints, result.json) live in the
// system temp dir, one folder per repository, so they never fill the repo's .model-ladder/.
export function artifactDir(root) {
  const key = process.platform === 'linux' ? canonical(root) : canonical(root).toLowerCase()
  // One spelling (no 8.3 short names, no /var -> /private/var link), so git and the runner agree on worktree paths.
  return canonical(join(tmpdir(), 'model-ladder', createHash('sha256').update(key).digest('hex').slice(0, 16)))
}

export const samePath = (a, b) => canonical(a).toLowerCase() === canonical(b).toLowerCase()

export function worktrees(root) {
  const list = []
  for (const block of git(root, 'worktree', 'list', '--porcelain').split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    if (path) list.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null })
  }
  return list
}

// Called once a new run holds its lock. Other runs may be active, so it never touches a run dir an
// active lock names (its own runId or the run it resumes). Deletes the codex-<uuid> directories of
// finished runs under artifactDir(root), and under the legacy <root>/.model-ladder that older versions
// used, and unregisters their worktrees.
// Kept: runs without result.json (not known to be finished), CONFLICT runs, runs holding a patch or
// checkpoint, and under keepFailed every run that still has an attempt worktree. Never fails the run.
export function pruneRuns(root, { keepFailed = false } = {}) {
  const removed = []
  try {
    const used = new Set(readLocks(root).flatMap((lock) => [lock.runId, lock.resumeRun]).filter(Boolean))
    for (const base of [artifactDir(root), runDir(root)]) {
      if (!existsSync(base)) continue
      for (const name of readdirSync(base)) {
        const dir = join(base, name)
        if (!/^codex-[0-9a-f-]{36}$/.test(name) || used.has(name) || !existsSync(join(dir, 'result.json'))) continue
        const attempts = readdirSync(dir).filter((file) => /^attempt-\d+$/.test(file))
        let status
        try { status = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status } catch { continue }
        if (status === 'CONFLICT' || existsSync(join(dir, 'result.patch')) || existsSync(join(dir, 'checkpoint.json')) || keepFailed && attempts.length) continue
        const stuck = attempts.some((file) => !tryGit(root, 'worktree', 'remove', '--force', join(dir, file)).ok && worktrees(root).some((w) => samePath(w.path, join(dir, file))))
        if (stuck) continue
        rmSync(dir, { recursive: true, force: true })
        removed.push(name)
      }
    }
    tryGit(root, 'worktree', 'prune')
  } catch {}
  return removed
}

export const print =(value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
