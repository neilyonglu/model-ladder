// Applies a verified result, cleans up, appends history, and prints the report.
// stdin: JSON { "task": "...", "result": <workflow result> }
//    or  { "task": "...", "error": "..." }    the workflow crashed
//    or  { "task": "...", "aborted": "..." }  the user stopped before the run
// Each input also carries "runId", the runId preflight printed.
// `--handoff` (no stdin) writes the template .model-ladder/HANDOFF.md from the last history entry instead.
// Always removes this run's lock, so a crash or a "no" never leaves the guard armed for it.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical } from '../hooks/guard.mjs'
import { git, print, repoRoot, runDir, samePath, tryGit, worktrees } from './common.mjs'
import { readLocks, releaseLock, runFiles, withMutex } from './runs.mjs'
import { updateNote } from './update-check.mjs'

function apply(root, run, state, winner) {
  const wt = winner.worktreePath
  git(wt, 'add', '-A')
  const resultTree = git(wt, 'write-tree')
  // Against BASE_TREE, not HEAD: the user's own uncommitted changes stay out of the patch.
  const patch = join(run, 'result.patch')
  // Raw output, not git(): trimEnd() would strip a final blank context line and corrupt the patch.
  writeFileSync(patch, execFileSync('git', ['diff', '--binary', state.baseTree, resultTree], { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }))
  const files = git(root, 'diff', '--name-only', state.baseTree, resultTree).split('\n').filter(Boolean)
  if (!files.length) return { applied: false, files, note: 'read-only attempt, nothing to apply' }
  // One run writes into the checkout at a time; a run whose files changed meanwhile gets a conflict.
  return withMutex(root, 'apply', () => {
    const applied = tryGit(root, 'apply', patch)
    if (!applied.ok) {
      return { applied: false, files, keep: wt, note: `the patch does not apply cleanly (files changed during the run?). Worktree kept at ${wt}; patch at ${patch}` }
    }
    rmSync(patch)
    if (!state.config.commit) return { applied: true, files, committed: null }
    git(root, 'add', '--', ...files)
    git(root, 'commit', '-q', '-m', `model-ladder: ${winner.goal}`, '--', ...files)
    return { applied: true, files, committed: git(root, 'rev-parse', '--short', 'HEAD') }
  })
}

const under = (path, dir) => canonical(path).toLowerCase().startsWith(`${canonical(dir).toLowerCase()}${sep}`)

// Worktrees an earlier run kept (conflict, keepFailed, usage limit), as finish recorded them in history.
function keptByHistory(run) {
  try {
    return readFileSync(join(run, 'history.jsonl'), 'utf8').split('\n').flatMap((line) => {
      try { return JSON.parse(line).kept ?? [] } catch { return [] }
    })
  } catch { return [] }
}

// Removes this run's worktrees: those its attempts reported, and, when no other Claude Code run is
// active, any other worktree under .claude/worktrees/ created since preflight that no run kept (a
// worker that died before reporting). With another run active those may be its own, so they stay.
// keepOrphans (a run stopped by Claude's limit): an unreported worktree is the attempt that died mid-work, so it
// stays for the resume instead. Returns the orphans it kept.
function cleanup(root, state, keep, known, runId, keepOrphans = false) {
  const others = readLocks(root).filter((lock) => (runId ? lock.legacy || lock.runId !== runId : !lock.legacy) && lock.runtime !== 'codex')
  const kept = keptByHistory(runDir(root))
  const orphans = []
  for (const wt of worktrees(root)) {
    if ((state.before ?? []).some((p) => samePath(p, wt.path))) continue
    if (keep.some((p) => samePath(p, wt.path))) continue
    const mine = known.some((p) => samePath(p, wt.path))
    const orphan = !others.length && under(wt.path, join(root, '.claude', 'worktrees')) && !kept.some((p) => samePath(p, wt.path))
    if (!mine && !orphan) continue
    if (!mine && keepOrphans) { orphans.push(wt.path); continue }
    tryGit(root, 'worktree', 'remove', '--force', wt.path)
    if (wt.branch) tryGit(root, 'branch', '-D', wt.branch)
  }
  return orphans
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
  if (outcome.handoff) lines.push(`Handoff   ${outcome.handoff}`)
  // A read-only attempt's report is the deliverable; nothing else carries it back.
  if (result.status === 'VERIFIED' && !outcome.files?.length && result.winner?.summary) lines.push('', 'Report', '', result.winner.summary)
  if (result.final) lines.push('', `Why       ${result.final.reason}`, `Next      ${result.final.suggestion}`)
  for (const note of notes) lines.push('', note)
  return lines.join('\n')
}

// stopped: the "Stopped" line; a USAGE_LIMIT run states its reason, a manual handoff says so.
function handoff(task, result, worktree, stopped = `USAGE_LIMIT: ${result.final?.reason ?? 'usage reached the threshold'}`) {
  const attempts = result.attempts.map((a, i) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`)
  const contexts = result.attempts.flatMap((a) => [a.modelContext, a.diagnosisContext].filter(Boolean))
  if (result.winner?.summary && !contexts.some((c) => c.text === result.winner.summary)) contexts.push({ source: 'winning worker', text: result.winner.summary })
  return `# model-ladder handoff

## Task
${task}

## Stopped
${stopped}

## Attempts
${attempts.join('\n') || 'none'}

## Generated status and verification
Status: ${result.status}. Attempt PASS/FAIL results above are generated verification results and remain authoritative.

## Model context (unverified)
${contexts.length ? contexts.map((c) => `### ${c.source}\n${c.text}`).join('\n\n') : 'No model context was captured.'}

Context comes from the model output named above. Treat it as claims, not verification evidence. Parent conversation context was not available to this run.

## Worktree
${worktree ?? 'none kept (the last attempt had no worktree)'}

## Resume
${result.status === 'USAGE_LIMIT' ? 'After the usage limit resets, run' : 'To start the task again, run'} \`/model-ladder:run ${task}\` again.${worktree ? ` The kept worktree above holds the last attempt's code; look at it for what was already tried.` : ''}
`
}

// `finish.mjs --handoff`: the template HANDOFF.md for the last run in history.jsonl, which /model-ladder:handoff then rewrites.
function manualHandoff(root) {
  const run = runDir(root)
  let last
  try { last = JSON.parse(readFileSync(join(run, 'history.jsonl'), 'utf8').trim().split('\n').at(-1)) } catch { /* no history */ }
  if (!last) return 'model-ladder handoff: no run history in .model-ladder/history.jsonl; no template written.'
  const result = { status: last.status, attempts: last.attempts ?? [], winner: last.winner }
  const path = join(run, 'HANDOFF.md')
  writeFileSync(path, handoff(last.task, result, (last.kept ?? []).at(-1), `Manual handoff (last run ended ${last.status}, ${last.date})`))
  return `model-ladder handoff: template written to ${path}`
}

// Every status workflows/ladder.js returns.
const STATUSES = ['VERIFIED', 'FAILED', 'STOPPED', 'DIRECT', 'USAGE_LIMIT', 'NEEDS_INPUT']

// Runs before anything is cleaned: a wrong shape must never cost a verified worktree.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('input must be a JSON object {task, result} | {task, error} | {task, aborted}')
  const { task, result, error, aborted } = input
  if (typeof task !== 'string' || !task) throw new Error('task missing — input must be {task, result} | {task, error} | {task, aborted}')
  if (input.runId !== undefined && (typeof input.runId !== 'string' || !/^[\w.-]+$/.test(input.runId))) throw new Error('runId must be the runId preflight printed')
  if (result === undefined) {
    if (aborted === undefined && error === undefined) throw new Error('input needs one of result, error or aborted')
    return
  }
  if (!result || typeof result !== 'object') throw new Error("result must be the workflow's result object")
  if (result.status === undefined) throw new Error("result.status missing — pass the workflow's result field, not the whole output")
  if (!STATUSES.includes(result.status)) throw new Error(`result.status "${result.status}" is unknown — expected one of ${STATUSES.join(', ')}`)
  if (result.status === 'VERIFIED' && !result.winner) throw new Error('result.status is VERIFIED but result.winner is missing')
}

function main(input) {
  validate(input)
  const root = repoRoot()
  const run = runDir(root)
  const { task, result, error, aborted, runId } = input
  // Without a runId: a run an older preflight started, with its files and run.json in .model-ladder/.
  const files = runId ? runFiles(root, runId) : run
  const statePath = join(files, 'state.json')
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { before: [], config: {} }
  const notes = []
  let outcome = { applied: false, files: [] }
  let keep = []

  // A read-only winner ran in the user's own checkout; apply would stage their changes.
  if (result?.status === 'VERIFIED' && !result.winner.filesChanged?.length) {
    outcome = { applied: false, files: [], note: 'read-only attempt, nothing to apply' }
  } else if (result?.status === 'VERIFIED') {
    outcome = apply(root, files, state, { ...result.winner, goal: result.plan.goal })
    if (outcome.keep) keep = [outcome.keep]
  }
  if (result && result.status !== 'VERIFIED' && state.config.keepFailed) {
    keep = result.attempts.map((a) => a.worktreePath).filter(Boolean)
    if (keep.length) notes.push(`Failed attempts kept (keepFailed): ${keep.join(', ')}`)
  }
  // The last attempt's worktree is what a resumed run can look at. A worker stopped by Claude's limit never
  // reported its worktree; cleanup keeps such an unreported one, and it is the last attempt's.
  const limited = result?.status === 'USAGE_LIMIT'
  let lastWorktree = limited ? result.attempts.map((a) => a.worktreePath).filter(Boolean).at(-1) ?? null : null
  if (lastWorktree && !keep.includes(lastWorktree)) keep.push(lastWorktree)
  const known = [...(result?.attempts ?? []).map((a) => a.worktreePath), result?.winner?.worktreePath].filter(Boolean)
  const orphans = cleanup(root, state, keep, known, runId, limited)
  keep.push(...orphans)
  if (orphans.length && !result.attempts.at(-1)?.worktreePath) lastWorktree = orphans.at(-1)
  if (runId) {
    releaseLock(root, runId)
    // A conflict's result.patch stays for review; the rest of the run's files go.
    if (existsSync(join(files, 'result.patch'))) for (const f of ['setup.patch', 'state.json', 'index']) rmSync(join(files, f), { force: true })
    else rmSync(files, { recursive: true, force: true })
  } else {
    for (const f of ['run.json', 'setup.patch', 'state.json', 'index']) rmSync(join(run, f), { force: true })
  }

  if (aborted) return `model-ladder stopped before running: ${aborted}`

  appendFileSync(join(run, 'history.jsonl'), `${JSON.stringify({
    date: new Date().toISOString(),
    runId: runId ?? null,
    task,
    status: result?.status ?? 'ERROR',
    start: result?.plan?.start ?? null,
    attempts: (result?.attempts ?? []).map((a) => ({ cell: a.cell, pass: a.pass, reason: a.reason, action: a.action, tokens: a.tokens, modelContext: a.modelContext, diagnosisContext: a.diagnosisContext })),
    winner: result?.winner ? { summary: result.winner.summary } : null,
    tokens: result?.tokens ?? 0,
    applied: outcome.applied,
    committed: Boolean(outcome.committed),
    kept: keep,
    error: error ?? null,
  })}\n`)

  if (result?.status === 'USAGE_LIMIT') {
    outcome.handoff = join(run, 'HANDOFF.md')
    writeFileSync(outcome.handoff, handoff(task, result, lastWorktree))
  }

  if (result?.status === 'DIRECT') {
    return [`model-ladder ── DIRECT`, '', `Task      ${task}`, `Why       ${result.plan.directReason}`,
      'Next      The calling session does the task itself. Start the task with --ladder to force the ladder.', ...notes.flatMap((n) => ['', n])].join('\n')
  }
  if (error) return [`model-ladder ── ERROR`, '', `Task      ${task}`, `Error     ${error}`, '', 'Worktrees and the run lock were cleaned up.', ...notes].join('\n')
  return report(task, result, outcome, notes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const text = process.argv.includes('--handoff') ? manualHandoff(repoRoot()) : main(JSON.parse(readFileSync(0, 'utf8')))
    const update = await updateNote()
    print(update ? `${text}\n\n${update}` : text)
  } catch (e) {
    print(`model-ladder finish failed: ${String(e.stderr ?? e.message)}`)
    process.exitCode = 1
  }
}
