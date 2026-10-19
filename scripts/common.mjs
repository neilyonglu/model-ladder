import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
export const tryGit = (cwd, ...args) => {
  try {
    return { ok: true, out: git(cwd, ...args) }
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.message) }
  }
}

export const repoRoot = () => git(process.cwd(), 'rev-parse', '--show-toplevel')
// Run files live outside .git and .claude: Claude Code asks permission to change files in both.
export const runDir = (root) => join(root, '.model-ladder')

export const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

export function worktrees(root) {
  const list = []
  for (const block of git(root, 'worktree', 'list', '--porcelain').split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1]
    if (path) list.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null })
  }
  return list
}

export const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
