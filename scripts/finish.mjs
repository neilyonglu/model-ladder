// Applies a verified result, cleans up, appends history, and prints the report.
// stdin: JSON { "task": "...", "result": <workflow result> }
//    or  { "task": "...", "error": "..." }    the workflow crashed
//    or  { "task": "...", "aborted": "..." }  the user stopped before the run
// Always removes the run marker, so a crash or a "no" never leaves the guard armed.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { git, print, repoRoot, runDir, samePath, tryGit, worktrees } from './common.mjs'

function apply(root, run, state, winner) {
  const wt = winner.worktreePath
  git(wt, 'add', '-A')
  const resultTree = git(wt, 'write-tree')
  // Against BASE_TREE, not HEAD: the user's own uncommitted changes stay out of the patch.
  const patch = join(run, 'result.patch')
  writeFileSync(patch, git(root, 'diff', '--binary', state.baseTree, resultTree) + '\n')
  const files = git(root, 'diff', '--name-only', state.baseTree, resultTree).split('\n').filter(Boolean)
  if (!files.length) return { applied: false, files, note: 'the winning attempt changed nothing' }
  const applied = tryGit(root, 'apply', patch)
  if (!applied.ok) {
    return { applied: false, files, keep: wt, note: `the patch does not apply cleanly (files changed during the run?). Worktree kept at ${wt}; patch at ${patch}` }
  }
  rmSync(patch)
  if (!state.config.commit) return { applied: true, files, committed: null }
  git(root, 'add', '--', ...files)
  git(root, 'commit', '-q', '-m', `model-ladder: ${winner.goal}`, '--', ...files)
  return { applied: true, files, committed: git(root, 'rev-parse', '--short', 'HEAD') }
}

function cleanup(root, state, keep) {
  for (const wt of worktrees(root)) {
    if ((state.before ?? []).some((p) => samePath(p, wt.path))) continue
    if (keep.some((p) => samePath(p, wt.path))) continue
    tryGit(root, 'worktree', 'remove', '--force', wt.path)
    if (wt.branch) tryGit(root, 'branch', '-D', wt.branch)
  }
}

function report(task, result, outcome, notes) {
  const plan = result.plan
  const rows = result.attempts.map((a, i) => {
    const why = a.action ? `${a.action}: ${a.actionReason}` : a.pass ? '—' : a.reason
    return `${String(i + 1).padEnd(2)} ${a.cell.replace('/', ' / ').padEnd(16)} ${(a.pass ? 'PASS' : 'FAIL').padEnd(8)} ${why}`
  })
  const tests = plan.allowTests ? 'allowed' : 'protected'
  const applied = outcome.applied
    ? outcome.committed ? `committed as ${outcome.committed}` : `to the working tree (not committed)`
    : `not applied${outcome.note ? `: ${outcome.note}` : ''}`
  const lines = [
    `model-ladder ── ${result.status}`,
    '',
    `Task      ${task}`,
    `Verify    ${plan.verify ?? 'acceptance criteria'}`,
    `Tests     ${tests} (router: ${plan.allowTestsReason})`,
    `Start     ${plan.start} (router: ${plan.startReason})`,
    '',
    '#  Model / Effort   Result   Why next',
    ...rows,
    '',
    `Changed   ${outcome.files?.length ? outcome.files.join(', ') : '—'}`,
    `Applied   ${result.status === 'VERIFIED' ? applied : 'nothing (no verified attempt)'}`,
    `Tokens    ${result.tokens} output (route + attempts)`,
  ]
  if (result.final) lines.push('', `Why       ${result.final.reason}`, `Next      ${result.final.suggestion}`)
  for (const note of notes) lines.push('', note)
  return lines.join('\n')
}

function main(input) {
  const root = repoRoot()
  const run = runDir(root)
  const statePath = join(run, 'state.json')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { before: [], config: {} }
  const { task, result, error, aborted } = input
  const notes = []
  let outcome = { applied: false, files: [] }
  let keep = []

  if (result?.status === 'VERIFIED') {
    outcome = apply(root, run, state, { ...result.winner, goal: result.plan.goal })
    if (outcome.keep) keep = [outcome.keep]
  }
  if (result && result.status !== 'VERIFIED' && state.config.keepFailed) {
    keep = result.attempts.map((a) => a.worktreePath).filter(Boolean)
    if (keep.length) notes.push(`Failed attempts kept (keepFailed): ${keep.join(', ')}`)
  }
  cleanup(root, state, keep)
  for (const f of ['run.json', 'setup.patch', 'state.json', 'index']) rmSync(join(run, f), { force: true })

  if (aborted) return `model-ladder stopped before running: ${aborted}`

  appendFileSync(join(run, 'history.jsonl'), `${JSON.stringify({
    date: new Date().toISOString(),
    task,
    status: result?.status ?? 'ERROR',
    start: result?.plan?.start ?? null,
    attempts: (result?.attempts ?? []).map((a) => ({ cell: a.cell, pass: a.pass, reason: a.reason, action: a.action, tokens: a.tokens })),
    tokens: result?.tokens ?? 0,
    applied: outcome.applied,
    committed: Boolean(outcome.committed),
    error: error ?? null,
  })}\n`)

  const ignored = (p) => tryGit(root, 'check-ignore', '-q', p).ok
  if (!ignored('.model-ladder/history.jsonl') || !ignored('.claude/worktrees/x')) {
    notes.push('Tip: add `.model-ladder/` and `.claude/worktrees/` to .gitignore.')
  }

  if (error) return [`model-ladder ── ERROR`, '', `Task      ${task}`, `Error     ${error}`, '', 'Worktrees and the run marker were cleaned up.', ...notes].join('\n')
  return report(task, result, outcome, notes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    print(main(JSON.parse(readFileSync(0, 'utf8'))))
  } catch (e) {
    print(`model-ladder finish failed: ${String(e.stderr ?? e.message)}`)
    process.exitCode = 1
  }
}
