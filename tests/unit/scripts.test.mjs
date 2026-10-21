import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const read = (dir, file) => readFileSync(join(dir, file), 'utf8')
const write = (dir, file, text) => {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}

function repo(files = { 'a.py': 'a = 1\n', 'b.py': 'b = 1\n', 'tests/test_a.py': 'def test(): pass\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-scripts-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'core.autocrlf', 'false')
  for (const [f, text] of Object.entries(files)) write(dir, f, text)
  write(dir, '.gitignore', '.model-ladder/\n.claude/worktrees/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const preflight = (dir, ...flags) => JSON.parse(execFileSync('node', [script('preflight'), ...flags], { cwd: dir, encoding: 'utf8' }))
const finish = (dir, input) => execFileSync('node', [script('finish')], {
  cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
})

// Stands in for a worker: a worktree created after preflight, with some edits.
function worktree(dir, name, edits) {
  const path = join(dir, '.claude', 'worktrees', name)
  git(dir, 'worktree', 'add', '-q', path, '-b', `worktree-${name}`)
  for (const [f, text] of Object.entries(edits)) write(path, f, text)
  return path
}

const verified = (wt, files) => ({
  status: 'VERIFIED',
  plan: { goal: 'fix b', verify: 'pytest', start: 'haiku/low', startReason: 'small', allowTests: false, allowTestsReason: 'bug fix' },
  attempts: [{ cell: 'haiku/low', pass: true, reason: 'ok', action: null, actionReason: null, tokens: 100, worktreePath: wt }],
  winner: { worktreePath: wt, filesChanged: files },
  final: null,
  tokens: 150,
})

test('clean repo: READY, marker armed with test patterns, protection for the workflow', () => {
  const dir = repo()
  const out = preflight(dir)
  assert.equal(out.status, 'READY')
  assert.ok(out.workflowArgs.protection.tests.includes('**/tests/**'))
  assert.deepEqual(out.workflowArgs.protection.always, ['.claude/model-ladder.json'])
  assert.equal(out.workflowArgs.config.verifier.model, 'haiku')
  assert.equal(out.workflowArgs.setupPatch, null)
  assert.equal(out.workflowArgs.baseCommit, git(dir, 'rev-parse', 'HEAD'))
  const marker = JSON.parse(read(dir, '.model-ladder/run.json'))
  assert.ok(marker.tests.includes('**/tests/**'))
})

test('a second run sees the marker; --clear-stale removes it', () => {
  const dir = repo()
  preflight(dir)
  assert.equal(preflight(dir).status, 'STALE_RUN')
  assert.equal(preflight(dir, '--clear-stale').status, 'READY')
})

test('invalid config is an ERROR naming the problem', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ tiers: [{ model: 'haiku', efforts: ['huge'], maxEffortJump: 1 }] }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'config')
  const out = preflight(dir)
  assert.equal(out.status, 'ERROR')
  assert.match(out.message, /efforts must be from/)
})

test('project config overrides defaults key by key', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ maxAttempts: 2, protected: ['migrations/**'] }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'config')
  const out = preflight(dir)
  assert.equal(out.workflowArgs.config.maxAttempts, 2)
  assert.equal(out.workflowArgs.config.tiers.length, 3)
  assert.ok(out.workflowArgs.protection.always.includes('migrations/**'))
})

test('dirty tree: DIRTY first; with consent, a snapshot that leaves the real index alone', () => {
  const dir = repo()
  write(dir, 'a.py', 'a = 2\n')
  write(dir, 'new.py', 'n = 1\n')
  const asked = preflight(dir)
  assert.equal(asked.status, 'DIRTY')
  assert.deepEqual(asked.files.sort(), ['a.py', 'new.py'])
  const out = preflight(dir, '--allow-dirty')
  assert.equal(out.status, 'READY')
  assert.deepEqual(out.workflowArgs.setupFiles.sort(), ['a.py', 'new.py'])
  assert.ok(existsSync(out.workflowArgs.setupPatch))
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), '')
})

test('dirty tree without .model-ladder ignored: the snapshot still leaves out the run dir', () => {
  const dir = repo()
  git(dir, 'rm', '-q', '.gitignore')
  git(dir, 'commit', '-q', '-m', 'no ignore')
  write(dir, 'a.py', 'a = 2\n')
  const out = preflight(dir, '--allow-dirty')
  assert.equal(out.status, 'READY', out.message)
  assert.deepEqual(out.workflowArgs.setupFiles, ['a.py'])
})

test('VERIFIED: applies only the worker change, cleans up, writes history', () => {
  const dir = repo()
  preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 2\n', 'c.py': 'c = 1\n' })
  const report = finish(dir, { task: 'fix b', result: verified(wt, ['b.py', 'c.py']) })
  assert.match(report, /model-ladder ── VERIFIED/)
  assert.match(report, /to the working tree \(not committed\)/)
  assert.equal(read(dir, 'b.py'), 'b = 2\n')
  assert.equal(read(dir, 'c.py'), 'c = 1\n')
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1)
  assert.doesNotMatch(git(dir, 'branch'), /worktree-wf_1/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  const history = read(dir, '.model-ladder/history.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(history.at(-1).status, 'VERIFIED')
  assert.equal(history.at(-1).applied, true)
})

test('dirty run: the user change stays, the patch carries only the worker change', () => {
  const dir = repo()
  write(dir, 'a.py', 'a = 2\n')
  const out = preflight(dir, '--allow-dirty')
  const wt = worktree(dir, 'wf_1', {})
  git(wt, 'apply', out.workflowArgs.setupPatch)
  write(wt, 'b.py', 'b = 2\n')
  finish(dir, { task: 'fix b', result: verified(wt, ['b.py']) })
  assert.equal(read(dir, 'a.py'), 'a = 2\n')
  assert.equal(read(dir, 'b.py'), 'b = 2\n')
})

test('commit: true commits only the patch files', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ commit: true }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'config')
  write(dir, 'a.py', 'a = 2\n')
  preflight(dir, '--allow-dirty')
  const wt = worktree(dir, 'wf_1', { 'a.py': 'a = 2\n', 'b.py': 'b = 2\n' })
  const report = finish(dir, { task: 'fix b', result: verified(wt, ['b.py']) })
  assert.match(report, /committed as/)
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'b.py')
  assert.match(git(dir, 'status', '--porcelain'), /a\.py/)
})

test('a conflicting apply keeps the winning worktree and the patch', () => {
  const dir = repo()
  preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 2\n' })
  write(dir, 'b.py', 'b = 99\n')
  const report = finish(dir, { task: 'fix b', result: verified(wt, ['b.py']) })
  assert.match(report, /not applied: the patch does not apply cleanly/)
  assert.equal(read(dir, 'b.py'), 'b = 99\n')
  assert.ok(existsSync(wt))
  assert.ok(existsSync(join(dir, '.model-ladder', 'result.patch')))
})

test('FAILED: worktrees removed, kept only with keepFailed', () => {
  const failed = (wt) => ({ ...verified(wt, []), status: 'FAILED', winner: null, attempts: [{ ...verified(wt, []).attempts[0], pass: false }], final: { reason: 'r', suggestion: 's' } })
  const dir = repo()
  preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 3\n' })
  assert.match(finish(dir, { task: 't', result: failed(wt) }), /Next {6}s/)
  assert.ok(!existsSync(wt))
  assert.equal(read(dir, 'b.py'), 'b = 1\n')

  const keepDir = repo()
  write(keepDir, '.claude/model-ladder.json', JSON.stringify({ keepFailed: true }))
  git(keepDir, 'add', '-A')
  git(keepDir, 'commit', '-q', '-m', 'config')
  preflight(keepDir)
  const kept = worktree(keepDir, 'wf_1', { 'b.py': 'b = 3\n' })
  finish(keepDir, { task: 't', result: failed(kept) })
  assert.ok(existsSync(kept))
})

test('VERIFIED read-only: nothing applied, the report is printed', () => {
  const dir = repo()
  preflight(dir)
  const wt = worktree(dir, 'wf_ro', {})
  const result = verified(wt, [])
  result.winner.summary = 'A-D tables'
  const report = finish(dir, { task: 'review', result })
  assert.match(report, /read-only attempt, nothing to apply/)
  assert.match(report, /Report\n\nA-D tables/)
})

test('DIRECT: nothing applied, guard disarmed, history says DIRECT', () => {
  const dir = repo()
  preflight(dir)
  const out = finish(dir, { task: 't', result: { status: 'DIRECT', plan: { goal: 'g', directReason: 'one function' }, attempts: [], tokens: 10 } })
  assert.match(out, /DIRECT/)
  assert.match(out, /one function/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  assert.equal(JSON.parse(read(dir, '.model-ladder/history.jsonl').trim()).status, 'DIRECT')
})

test('aborted or crashed runs still disarm the guard', () => {
  const dir = repo()
  preflight(dir)
  assert.match(finish(dir, { task: 't', aborted: 'user declined' }), /stopped before running/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  preflight(dir)
  assert.match(finish(dir, { task: 't', error: 'workflow crashed' }), /ERROR/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
})

test('preflight snapshot failure releases its own marker and temporary index', () => {
  const dir = repo()
  write(dir, '.gitattributes', '*.py filter=broken\n')
  write(dir, 'a.py', 'changed\n')
  git(dir, 'config', 'filter.broken.clean', 'exit 1')
  git(dir, 'config', 'filter.broken.required', 'true')
  const out = preflight(dir, '--allow-dirty')
  assert.equal(out.status, 'ERROR')
  assert.match(out.message, /filter.*failed|clean filter/)
  assert.equal(existsSync(join(dir, '.model-ladder/run.json')), false)
  assert.equal(existsSync(join(dir, '.model-ladder/index')), false)
})
