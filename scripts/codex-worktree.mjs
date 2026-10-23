import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProtected } from '../hooks/guard.mjs'
import { ARTIFACTS } from './ladder-rules.mjs'

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
}
const paths = ['--', '.', ':!.model-ladder', ':!.claude/worktrees']
export function snapshot(cwd, run, name) {
  const index = join(run, `${name}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  const g = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd()
  try {
    g('read-tree', 'HEAD')
    g('add', '-A')
    g('rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', '.model-ladder', '.claude/worktrees')
    return g('write-tree')
  } finally { rmSync(index, { force: true }) }
}
export function changed(cwd, from, to, artifactBaseline = from) {
  const files = git(cwd, 'diff', '--no-ext-diff', '--name-only', '--no-renames', '-z', from, to, ...paths).split('\0').filter(Boolean)
  const tracked = new Set(git(cwd, 'ls-tree', '-r', '--name-only', '-z', artifactBaseline).split('\0'))
  return files.filter((file) => !isProtected(file, ARTIFACTS) || tracked.has(file))
}
export function protectedChange(cwd, baseTree, tree, patterns) {
  return changed(cwd, baseTree, tree).find((file) => isProtected(file, patterns))
}
export function makeWorktree(root, run, number, baseCommit, baseTree) {
  const cwd = join(run, `attempt-${number}`)
  git(root, 'worktree', 'add', '--detach', '-q', cwd, baseCommit)
  try { git(cwd, 'read-tree', '--reset', '-u', baseTree) }
  catch (error) { git(root, 'worktree', 'remove', '--force', cwd); throw error }
  return cwd
}
export function applyResult(root, run, baseTree, resultTree, baseCommit) {
  const files = changed(root, baseTree, resultTree)
  if (!files.length) return { applied: false, files, note: 'No file changes' }
  const patch = join(run, 'result.patch')
  writeFileSync(patch, execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', baseTree, resultTree, '--', ...files.map((file) => `:(literal)${file}`)], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  try {
    if (git(root, 'rev-parse', 'HEAD') !== baseCommit) throw new Error('Original checkout changed commits')
    git(root, 'apply', '--check', patch)
    git(root, 'apply', patch)
    rmSync(patch)
    return { applied: true, files }
  } catch { return { applied: false, files, patch, note: 'Patch conflict. Kept the verified worktree and patch.' } }
}
export function removeOwned(root, paths, keep = []) {
  const errors = []
  for (const cwd of paths) {
    if (keep.includes(cwd)) continue
    try { git(root, 'worktree', 'remove', '--force', cwd) }
    catch (error) { errors.push(`Worktree retained at ${cwd}: ${String(error.stderr ?? error.message).slice(-500)}`) }
  }
  return errors
}
