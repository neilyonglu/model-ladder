// PreToolUse guard: during a model-ladder run, workers may not edit protected paths.
// Fails open: any error exits 0, and the verifier's diff check still catches the edit.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// `worker` fixes code and may not touch tests; `test-writer` is the worker for tasks that are about tests.
const WORKER = 'model-ladder:worker'
const TEST_WRITER = 'model-ladder:test-writer'

export const TEST_PATTERNS = [
  '**/test_*.py',
  '**/*_test.py',
  '**/tests/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/src/test/**',
]
// A worker could otherwise "pass" by rewriting the verify command.
export const ALWAYS_PROTECTED = ['.claude/model-ladder.json']

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function isProtected(relPath, patterns) {
  const path = relPath.replaceAll('\\', '/')
  return patterns.some((p) => globToRegExp(p).test(path))
}

// One spelling per path. On Windows the same folder can be C:\Users\RUNNER~1 (8.3 short name)
// or C:\Users\runneradmin, and git always reports the long one. The file itself may not exist
// yet (a worker about to create it), so resolve its nearest existing ancestor.
export function canonical(path) {
  const full = resolve(path)
  if (existsSync(full)) return realpathSync.native(full)
  const parent = dirname(full)
  return parent === full ? full : join(canonical(parent), basename(full))
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function check(input) {
  if (input.agent_type !== WORKER && input.agent_type !== TEST_WRITER) return null
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  if (!target) return null
  // Every worktree shares the main repo's .git; its parent is the main repo root.
  // The marker lives outside .git and .claude: Claude Code asks permission to change files in both.
  const mainRoot = dirname(resolve(input.cwd, git(input.cwd, 'rev-parse', '--git-common-dir')))
  const markerPath = join(mainRoot, '.model-ladder', 'run.json')
  if (!existsSync(markerPath)) return null
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  const patterns = input.agent_type === WORKER ? [...marker.protected, ...marker.tests] : marker.protected
  const root = canonical(git(input.cwd, 'rev-parse', '--show-toplevel'))
  const rel = relative(root, canonical(isAbsolute(target) ? target : resolve(input.cwd, target)))
  if (!isProtected(rel, patterns)) return null
  return `model-ladder: ${rel.replaceAll('\\', '/')} is protected during this run. Fix the code, not the tests.`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const reason = check(JSON.parse(readFileSync(0, 'utf8')))
    if (reason) {
      process.stderr.write(reason)
      process.exit(2)
    }
  } catch {
    process.exit(0)
  }
}
