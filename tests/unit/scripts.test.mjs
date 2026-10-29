import { freshUserConfig } from '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = (name) => fileURLToPath(new URL(`../../scripts/${name}.mjs`, import.meta.url))
const dirs = []
// The usage guard is on by default: an empty Claude config dir keeps this machine's real usage out of every test.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ml-no-usage-'))
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
const lockFile = (dir, runId) => join(dir, '.model-ladder', 'runs', `${runId}.json`)
// Lock files only: runs/ also holds per-run file dirs and mutex files.
const locks = (dir) => existsSync(join(dir, '.model-ladder', 'runs')) ? readdirSync(join(dir, '.model-ladder', 'runs')).filter((f) => f.endsWith('.json')) : []

// Writes the usage file the statusline script would, in a temp CLAUDE_CONFIG_DIR, and runs preflight against it.
function guarded(dir, percent, guard = { enabled: true, threshold: 90 }) {
  write(dir, '.claude/model-ladder.json', JSON.stringify({ usageGuard: guard }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'config')
  const config = mkdtempSync(join(tmpdir(), 'ml-claude-'))
  dirs.push(config)
  const now = Date.now() / 1000
  if (percent !== null) writeFileSync(join(config, 'model-ladder-usage.json'), JSON.stringify({ updatedAt: now, five_hour: { used_percentage: percent, resets_at: now + 3600 }, seven_day: null }))
  return JSON.parse(execFileSync('node', [script('preflight')], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } }))
}
const finish = (dir, input) => execFileSync('node', [script('finish')], {
  cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
})
const claim = (dir, input, ...flags) => JSON.parse(execFileSync('node', [script('claim'), ...flags], { cwd: dir, input: JSON.stringify(input), encoding: 'utf8' }))

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

test('preflight passes the band-measured context only when context.json is fresh and valid', () => {
  const dir = repo()
  const ctx = (text) => { mkdirSync(join(dir, '.model-ladder'), { recursive: true }); writeFileSync(join(dir, '.model-ladder', 'context.json'), text) }
  const now = Math.floor(Date.now() / 1000)
  const args = () => { const out = preflight(dir, '--allow-dirty'); assert.equal(out.status, 'READY'); return out.workflowArgs }
  assert.ok(!('contextTokens' in args()), 'missing file')
  ctx(JSON.stringify({ tokens: 45000, window: 200000, updatedAt: now - 60 }))
  const fresh = args()
  assert.equal(fresh.contextTokens, 45000)
  assert.equal(fresh.contextWindow, 200000)
  ctx(JSON.stringify({ tokens: 45000, window: 200000, updatedAt: now - 11 * 60 }))
  const stale = args()
  assert.ok(!('contextTokens' in stale) && !('contextWindow' in stale), 'stale file')
  ctx('{ not json')
  const corrupt = args()
  assert.ok(!('contextTokens' in corrupt) && !('contextWindow' in corrupt), 'corrupt file')
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
  assert.equal(out.workflowArgs.runId, out.runId)
  const marker = JSON.parse(readFileSync(lockFile(dir, out.runId), 'utf8'))
  assert.ok(marker.tests.includes('**/tests/**'))
  assert.deepEqual([marker.runtime, marker.pid, marker.scope], ['claude', null, null])
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
})

test('a second run gets its own lock instead of STALE_RUN', () => {
  const dir = repo()
  const first = preflight(dir)
  const second = preflight(dir)
  assert.equal(second.status, 'READY')
  assert.notEqual(second.runId, first.runId)
  assert.ok(existsSync(lockFile(dir, first.runId)) && existsSync(lockFile(dir, second.runId)))
})

test('a legacy run.json is STALE_RUN; --clear-stale removes only stale locks', () => {
  const dir = repo()
  const active = preflight(dir)
  write(dir, '.model-ladder/run.json', JSON.stringify({ protected: [], tests: [] }))
  const asked = preflight(dir)
  assert.equal(asked.status, 'STALE_RUN')
  assert.match(asked.message, /run\.json/)
  assert.equal(preflight(dir, '--clear-stale').status, 'READY')
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  assert.ok(existsSync(lockFile(dir, active.runId)), 'an active Claude Code run keeps its lock')
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

test('skill instructions come from the project config into workflowArgs, intact', () => {
  const dir = repo()
  assert.deepEqual(preflight(dir).workflowArgs.skills, { worker: '', verifier: '' })
  const worker = 'When coding, use ponytail, then simplify.\nWhen doing UI, use available UI/UX skills.'
  const verifier = 'When reviewing code, use ponytail; report only.'
  write(dir, '.claude/model-ladder.json', JSON.stringify({ worker_skills: worker, verifier_skills: verifier }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'skills')
  const out = preflight(dir)
  assert.equal(out.status, 'READY')
  assert.deepEqual(out.workflowArgs.skills, { worker, verifier })
})

test('skill instructions that are not strings are an ERROR before the marker', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ worker_skills: ['ponytail'], verifier_skills: 3 }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'skills')
  const out = preflight(dir)
  assert.equal(out.status, 'ERROR')
  assert.match(out.message, /worker_skills must be a string/)
  assert.match(out.message, /verifier_skills must be a string/)
  assert.deepEqual(locks(dir), [])
})

test('skill instructions are plugin options (the default for every project) that the run skill hands to preflight', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const options = JSON.parse(read(root, '.claude-plugin/plugin.json')).userConfig ?? {}
  for (const [key, title] of [['worker_skills', 'Worker skill instructions'], ['verifier_skills', 'Verifier skill instructions']]) {
    assert.equal(options[key]?.type, 'string', key)
    assert.equal(options[key].title, title)
    assert.equal(options[key].default, '')
    assert.match(options[key].description, /every project/)
    assert.match(options[key].description, new RegExp(`${key}.*\\.claude/model-ladder\\.json`))
  }
  const skill = read(root, 'skills/run/SKILL.md')
  assert.match(skill, /preflight\.mjs" --plugin-options <<'EOF'\n\{ "worker_skills": "\$\{user_config\.worker_skills\}", "verifier_skills": "\$\{user_config\.verifier_skills\}", "direct_threshold": "\$\{user_config\.direct_threshold\}", "split_minutes": "\$\{user_config\.split_minutes\}" \}\nEOF/)
  assert.match(skill, /"contextTokens": <estimate>, "contextWindow": <window>/)
  assert.match(read(root, 'hooks/band/register.tsx'), /pluginLayer\(options\)/)
})

// preflight with the plugin options on stdin, as skills/run/SKILL.md runs it.
const withOptions = (dir, options) => JSON.parse(execFileSync('node', [script('preflight'), '--plugin-options'], { cwd: dir, input: typeof options === 'string' ? options : JSON.stringify(options), encoding: 'utf8' }))

test('plugin skill options apply to every project; a project key wins; an unfilled ${...} is unset', () => {
  const dir = repo()
  const worker = 'When coding, use "ponytail".\nThen simplify.'
  assert.deepEqual(withOptions(dir, { worker_skills: worker, verifier_skills: 'review only' }).workflowArgs.skills, { worker, verifier: 'review only' })
  assert.deepEqual(withOptions(dir, { worker_skills: '${user_config.worker_skills}', verifier_skills: '${user_config.verifier_skills}' }).workflowArgs.skills, { worker: '', verifier: '' })
  write(dir, '.claude/model-ladder.json', JSON.stringify({ worker_skills: 'project worker', verifier_skills: '' }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'skills')
  assert.deepEqual(withOptions(dir, { worker_skills: 'plugin worker', verifier_skills: 'plugin verifier' }).workflowArgs.skills, { worker: 'project worker', verifier: '' })
})

test('direct_threshold: plugin picker, default 30, project overrides, bad value is an ERROR', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const opt = JSON.parse(read(root, '.claude-plugin/plugin.json')).userConfig.direct_threshold
  assert.deepEqual(opt.options, ['20', '30', '40', '50', '60', '70', '80', 'off'])
  assert.equal(opt.default, '30')
  assert.match(opt.description, /percentage of its context window/)
  const dir = repo()
  assert.equal(preflight(dir).workflowArgs.directThreshold, 30)
  assert.equal(withOptions(dir, { direct_threshold: '50' }).workflowArgs.directThreshold, 50)
  assert.equal(withOptions(dir, { direct_threshold: 'off' }).workflowArgs.directThreshold, 'off')
  assert.equal(withOptions(dir, { direct_threshold: '${user_config.direct_threshold}' }).workflowArgs.directThreshold, 30)
  write(dir, '.claude/model-ladder.json', JSON.stringify({ direct_threshold: 70 }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'dt')
  assert.equal(withOptions(dir, { direct_threshold: '20' }).workflowArgs.directThreshold, 70)
  write(dir, '.claude/model-ladder.json', JSON.stringify({ direct_threshold: 'sometimes' }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'bad')
  const bad = preflight(dir)
  assert.equal(bad.status, 'ERROR')
  assert.match(bad.message, /direct_threshold must be/)
})

test('split_minutes: plugin picker, default 20, project overrides, bad value is an ERROR', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const opt = JSON.parse(read(root, '.claude-plugin/plugin.json')).userConfig.split_minutes
  assert.equal(opt.type, 'string')
  assert.deepEqual(opt.options, ['10', '20', '30', '45', '60', 'off'])
  assert.equal(opt.default, '20')
  assert.equal('enum' in opt, false)
  const dir = repo()
  assert.equal(preflight(dir).workflowArgs.splitMinutes, 20)
  assert.equal(withOptions(dir, { split_minutes: '45' }).workflowArgs.splitMinutes, 45)
  assert.equal(withOptions(dir, { split_minutes: 'off' }).workflowArgs.splitMinutes, 'off')
  assert.equal(withOptions(dir, { split_minutes: '${user_config.split_minutes}' }).workflowArgs.splitMinutes, 20)
  write(dir, '.claude/model-ladder.json', JSON.stringify({ split_minutes: 60 }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'sm')
  assert.equal(withOptions(dir, { split_minutes: '10' }).workflowArgs.splitMinutes, 60)
  for (const value of ['soon', 0, -5, true]) {
    write(dir, '.claude/model-ladder.json', JSON.stringify({ split_minutes: value }))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'bad')
    const bad = preflight(dir)
    assert.equal(bad.status, 'ERROR', String(value))
    assert.match(bad.message, /split_minutes must be/)
  }
})

test('plugin options that are not JSON are an ERROR that says how to fix them, before any marker', () => {
  const dir = repo()
  const out = withOptions(dir, '{ "worker_skills": "say "hi"" }')
  assert.equal(out.status, 'ERROR')
  assert.match(out.message, /not valid JSON.*Escape quotes/)
  assert.deepEqual(locks(dir), [])
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
  const { runId } = preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 2\n', 'c.py': 'c = 1\n' })
  const report = finish(dir, { task: 'fix b', runId, result: verified(wt, ['b.py', 'c.py']) })
  assert.match(report, /model-ladder ── VERIFIED/)
  assert.match(report, /to the working tree \(not committed\)/)
  assert.equal(read(dir, 'b.py'), 'b = 2\n')
  assert.equal(read(dir, 'c.py'), 'c = 1\n')
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1)
  assert.doesNotMatch(git(dir, 'branch'), /worktree-wf_1/)
  assert.deepEqual(locks(dir), [])
  const history = read(dir, '.model-ladder/history.jsonl').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(history.at(-1).status, 'VERIFIED')
  assert.equal(history.at(-1).applied, true)
})

test('VERIFIED: a patch ending in a blank context line still applies', () => {
  const dir = repo({ 'z.py': 'x = 1\ny = 1\n\n' })
  const { runId } = preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'z.py': 'x = 2\ny = 1\n\n' })
  assert.match(finish(dir, { task: 'fix z', runId, result: verified(wt, ['z.py']) }), /to the working tree/)
  assert.equal(read(dir, 'z.py'), 'x = 2\ny = 1\n\n')
})

test('dirty run: the user change stays, the patch carries only the worker change', () => {
  const dir = repo()
  write(dir, 'a.py', 'a = 2\n')
  const out = preflight(dir, '--allow-dirty')
  const wt = worktree(dir, 'wf_1', {})
  git(wt, 'apply', out.workflowArgs.setupPatch)
  write(wt, 'b.py', 'b = 2\n')
  finish(dir, { task: 'fix b', runId: out.runId, result: verified(wt, ['b.py']) })
  assert.equal(read(dir, 'a.py'), 'a = 2\n')
  assert.equal(read(dir, 'b.py'), 'b = 2\n')
  assert.ok(!existsSync(join(dir, '.model-ladder', 'runs', out.runId)), 'state, setup patch and index removed')
})

test('commit: true commits only the patch files', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ commit: true }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'config')
  write(dir, 'a.py', 'a = 2\n')
  const { runId } = preflight(dir, '--allow-dirty')
  const wt = worktree(dir, 'wf_1', { 'a.py': 'a = 2\n', 'b.py': 'b = 2\n' })
  const report = finish(dir, { task: 'fix b', runId, result: verified(wt, ['b.py']) })
  assert.match(report, /committed as/)
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), 'b.py')
  assert.match(git(dir, 'status', '--porcelain'), /a\.py/)
})

test('a conflicting apply keeps the winning worktree and the patch', () => {
  const dir = repo()
  const { runId } = preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 2\n' })
  write(dir, 'b.py', 'b = 99\n')
  const report = finish(dir, { task: 'fix b', runId, result: verified(wt, ['b.py']) })
  assert.match(report, /not applied: the patch does not apply cleanly/)
  assert.equal(read(dir, 'b.py'), 'b = 99\n')
  assert.ok(existsSync(wt))
  assert.ok(existsSync(join(dir, '.model-ladder', 'runs', runId, 'result.patch')))
  assert.deepEqual(locks(dir), [])
})

test('FAILED: worktrees removed, kept only with keepFailed', () => {
  const failed = (wt) => ({ ...verified(wt, []), status: 'FAILED', winner: null, attempts: [{ ...verified(wt, []).attempts[0], pass: false }], final: { reason: 'r', suggestion: 's' } })
  const dir = repo()
  const { runId } = preflight(dir)
  const wt = worktree(dir, 'wf_1', { 'b.py': 'b = 3\n' })
  assert.match(finish(dir, { task: 't', runId, result: failed(wt) }), /Next {6}s/)
  assert.ok(!existsSync(wt))
  assert.equal(read(dir, 'b.py'), 'b = 1\n')

  const keepDir = repo()
  write(keepDir, '.claude/model-ladder.json', JSON.stringify({ keepFailed: true }))
  git(keepDir, 'add', '-A')
  git(keepDir, 'commit', '-q', '-m', 'config')
  const { runId: keepRun } = preflight(keepDir)
  const kept = worktree(keepDir, 'wf_1', { 'b.py': 'b = 3\n' })
  finish(keepDir, { task: 't', runId: keepRun, result: failed(kept) })
  assert.ok(existsSync(kept))
})

test('VERIFIED read-only: nothing applied, the report is printed', () => {
  const dir = repo()
  const { runId } = preflight(dir)
  const wt = worktree(dir, 'wf_ro', {})
  const result = verified(wt, [])
  result.winner.summary = 'A-D tables'
  const report = finish(dir, { task: 'review', runId, result })
  assert.match(report, /read-only attempt, nothing to apply/)
  assert.match(report, /Report\n\nA-D tables/)
})

test('DIRECT: nothing applied, guard disarmed, history says DIRECT', () => {
  const dir = repo()
  const { runId } = preflight(dir)
  const out = finish(dir, { task: 't', runId, result: { status: 'DIRECT', plan: { goal: 'g', directReason: 'one function' }, attempts: [], tokens: 10 } })
  assert.match(out, /DIRECT/)
  assert.match(out, /one function/)
  assert.deepEqual(locks(dir), [])
  assert.equal(JSON.parse(read(dir, '.model-ladder/history.jsonl').trim()).status, 'DIRECT')
})

test('aborted or crashed runs still disarm the guard', () => {
  const dir = repo()
  const first = preflight(dir)
  assert.match(finish(dir, { task: 't', runId: first.runId, aborted: 'user declined' }), /stopped before running/)
  assert.deepEqual(locks(dir), [])
  const second = preflight(dir)
  assert.match(finish(dir, { task: 't', runId: second.runId, error: 'workflow crashed' }), /ERROR/)
  assert.deepEqual(locks(dir), [])
})

test('claim: separate scopes run side by side; an overlap asks to wait; a gone run is cleared by ID', () => {
  const dir = repo()
  const a = preflight(dir)
  const b = preflight(dir)
  const c = preflight(dir)
  assert.equal(claim(dir, { runId: a.runId, scope: ['a.py'], readOnly: false }).status, 'READY')
  assert.equal(claim(dir, { runId: b.runId, scope: ['b.py'], readOnly: false }).status, 'READY')
  const blocked = claim(dir, { runId: c.runId, scope: ['b.py'], readOnly: false })
  assert.equal(blocked.status, 'NEEDS_INPUT')
  assert.deepEqual(blocked.overlaps.map((o) => o.runId), [b.runId])
  assert.ok(existsSync(lockFile(dir, b.runId)), 'never overwrites the other run')
  const cleared = claim(dir, { runId: c.runId, scope: ['b.py'], readOnly: false }, `--clear-stale=${b.runId}`)
  assert.equal(cleared.status, 'READY')
  assert.ok(!existsSync(lockFile(dir, b.runId)))
  assert.ok(existsSync(lockFile(dir, a.runId)))
  assert.equal(claim(dir, { runId: 'claude-missing', scope: [] }).status, 'ERROR')
})

test('finish leaves worktrees another active run may own, and the worktrees earlier runs kept', () => {
  const dir = repo()
  const a = preflight(dir)
  const b = preflight(dir)
  const c = preflight(dir)
  const mine = worktree(dir, 'wf_a', { 'a.py': 'a = 2\n' })
  const theirs = worktree(dir, 'wf_b', { 'b.py': 'b = 2\n' })
  finish(dir, { task: 'fix a', runId: a.runId, result: verified(mine, ['a.py']) })
  assert.equal(read(dir, 'a.py'), 'a = 2\n')
  assert.ok(!existsSync(mine))
  assert.ok(existsSync(theirs), "another active run's worktree stays")
  assert.ok(existsSync(lockFile(dir, b.runId)))

  // b conflicts and keeps its worktree; c, which started before it and finishes alone, must not remove it.
  write(dir, 'b.py', 'b = 99\n')
  finish(dir, { task: 'fix b', runId: b.runId, result: verified(theirs, ['b.py']) })
  assert.ok(existsSync(theirs))
  const orphan = worktree(dir, 'wf_c', {})
  finish(dir, { task: 't', runId: c.runId, error: 'worker died before reporting' })
  assert.ok(!existsSync(orphan), 'alone, an unreported worktree from this run is removed')
  assert.ok(existsSync(theirs), 'a worktree an earlier run kept stays')
})

test('finish without a runId closes a run an older preflight started (legacy run.json)', () => {
  const dir = repo()
  write(dir, '.model-ladder/run.json', JSON.stringify({ protected: [], tests: [] }))
  write(dir, '.model-ladder/state.json', JSON.stringify({ before: [], config: {} }))
  assert.match(finish(dir, { task: 't', aborted: 'user declined' }), /stopped before running/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'run.json')))
  assert.ok(!existsSync(join(dir, '.model-ladder', 'state.json')))
})

test('usageGuard on at the threshold: USAGE_LIMIT before any run marker', () => {
  const dir = repo()
  const out = guarded(dir, 95)
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.match(out.message, /95%.*90%/)
  assert.equal(existsSync(join(dir, '.model-ladder/run.json')), false)
  assert.deepEqual(locks(dir), [])
})

test('usageGuard on below the threshold: READY with the live guard command', () => {
  const dir = repo()
  const out = guarded(dir, 50)
  assert.equal(out.status, 'READY')
  assert.equal(out.usageNote, undefined)
  const file = out.workflowArgs.usageGuard.command.match(/^node "(.+usage-guard\.mjs)" --root "(.+)"$/)?.[1]
  assert.ok(file && existsSync(file), out.workflowArgs.usageGuard.command)
  assert.ok(existsSync(lockFile(dir, out.runId)))
})

test('usageGuard on with unknown usage: READY with a usageNote', () => {
  const out = guarded(repo(), null)
  assert.equal(out.status, 'READY')
  assert.match(out.usageNote, /no recent Claude usage/)
  assert.ok(out.workflowArgs.usageGuard)
})

test('usageGuard is on by default and reads the usage the band records in the project', () => {
  const dir = repo()
  const now = Date.now() / 1000
  write(dir, '.model-ladder/usage.json', JSON.stringify({ updatedAt: now, five_hour: { used_percentage: 97, resets_at: now + 3600 }, seven_day: null }))
  const out = preflight(dir)
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.match(out.message, /97%.*90%/)
  const percent = execFileSync('node', [script('usage-statusline'), '--percent', '--root', dir], { encoding: 'utf8' }).trim()
  assert.equal(percent, '97')
})

test('usageGuard off: READY even with high usage on file, and the command still goes along so turning it on mid-run counts', () => {
  const out = guarded(repo(), 99, { enabled: false })
  assert.equal(out.status, 'READY')
  assert.match(out.workflowArgs.usageGuard.command, /usage-guard\.mjs/)
  assert.equal(out.usageNote, undefined)
})

// Runs the guard command from workflowArgs the way the verifier does, against a usage file at `percent`.
function checkGuard(command, percent) {
  const [, file, root] = command.match(/^node "(.+)" --root "(.+)"$/)
  const config = mkdtempSync(join(tmpdir(), 'ml-claude-'))
  dirs.push(config)
  const now = Date.now() / 1000
  writeFileSync(join(config, 'model-ladder-usage.json'), JSON.stringify({ updatedAt: now, five_hour: { used_percentage: percent, resets_at: now + 3600 }, seven_day: null }))
  return JSON.parse(execFileSync('node', [file, '--root', root], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config } }))
}

test('guard settings are read live on every check: off, on and a new threshold mid-run all count at once', () => {
  const user = freshUserConfig()
  write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: false, threshold: 90 } }))
  const dir = repo()
  const { workflowArgs } = withOptions(dir, {})
  const { command } = workflowArgs.usageGuard
  assert.deepEqual(checkGuard(command, 95), { enabled: false, threshold: 90, usage: null })
  write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: true, threshold: 90 } }))
  assert.deepEqual(checkGuard(command, 95), { enabled: true, threshold: 90, usage: 95 })
  write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: true, threshold: 99 } }))
  assert.deepEqual(checkGuard(command, 95), { enabled: true, threshold: 99, usage: 95 })
  write(dirname(user), basename(user), '{ broken')
  assert.equal(checkGuard(command, 95).enabled, false, 'unreadable settings never stop a run')
  freshUserConfig()
})

test('user-level settings: the guard lives in ~/.claude/model-ladder.json; the project file still overrides it', () => {
  const user = freshUserConfig()
  try {
    const dir = repo()
    const now = Date.now() / 1000
    write(dir, '.model-ladder/usage.json', JSON.stringify({ updatedAt: now, five_hour: { used_percentage: 95, resets_at: now + 3600 }, seven_day: null }))
    assert.equal(preflight(dir).status, 'USAGE_LIMIT', 'on by default')
    write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: false } }))
    assert.equal(preflight(dir).status, 'READY', 'the user turned it off')
    write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: true, threshold: 99 } }))
    assert.equal(preflight(dir).status, 'READY', 'the user raised the threshold')
    write(dir, '.claude/model-ladder.json', JSON.stringify({ usageGuard: { threshold: 90 } }))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'project guard')
    assert.equal(preflight(dir).status, 'USAGE_LIMIT', 'a project threshold wins, keeping the user\'s on/off')
    write(dirname(user), basename(user), '{ nope')
    const broken = preflight(dir)
    assert.equal(broken.status, 'ERROR')
    assert.ok(broken.message.includes(user) && /not valid JSON/.test(broken.message), broken.message)
  } finally { freshUserConfig() }
})

test('finish never changes the guard in either settings file', () => {
  const user = freshUserConfig()
  try {
    const dir = repo()
    write(dir, '.claude/model-ladder.json', JSON.stringify({ usageGuard: { threshold: 95 } }))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'project guard')
    write(dirname(user), basename(user), JSON.stringify({ usageGuard: { enabled: false, threshold: 80 } }))
    const before = [read(dir, '.claude/model-ladder.json'), readFileSync(user, 'utf8')]
    for (const result of [
      { status: 'USAGE_LIMIT', plan: verified(null, []).plan, attempts: [], winner: null, tokens: 0, final: { reason: 'limit', suggestion: 'later' } },
      { status: 'FAILED', plan: verified(null, []).plan, attempts: [], winner: null, tokens: 0, final: { reason: 'no', suggestion: 'no' } },
    ]) {
      const { runId } = preflight(dir)
      finish(dir, { task: 't', runId, result })
      assert.deepEqual([read(dir, '.claude/model-ladder.json'), readFileSync(user, 'utf8')], before, result.status)
    }
  } finally { freshUserConfig() }
})

test('invalid usageGuard is an ERROR naming the problem', () => {
  assert.match(guarded(repo(), 10, { enabled: 'yes', threshold: 0 }).message, /usageGuard\.enabled.*usageGuard\.threshold/)
})

test('USAGE_LIMIT: keeps the last attempt worktree, writes HANDOFF.md, disarms the guard', () => {
  const dir = repo()
  const { runId } = preflight(dir)
  const first = worktree(dir, 'wf_1', { 'b.py': 'b = 3\n' })
  const last = worktree(dir, 'wf_2', { 'b.py': 'b = 4\n' })
  const attempt = (wt, cell) => ({ cell, pass: false, reason: 'tests fail', action: null, actionReason: null, tokens: 10, worktreePath: wt })
  const result = {
    ...verified(last, []), status: 'USAGE_LIMIT', winner: null,
    attempts: [attempt(first, 'haiku/low'), attempt(last, 'haiku/medium')],
    final: { reason: 'Claude usage 95% reached the usageGuard threshold of 90%.', suggestion: 'later' },
  }
  const report = finish(dir, { task: 'fix b', runId, result })
  const handoff = join(dir, '.model-ladder', 'HANDOFF.md')
  assert.match(report, /model-ladder ── USAGE_LIMIT/)
  // Not the full path: on Windows the temp dir and git spell it differently (short vs long names).
  assert.match(report, /Handoff {3}\S.*HANDOFF\.md/)
  const text = readFileSync(handoff, 'utf8')
  assert.match(text, /fix b/)
  assert.match(text, /Claude usage 95% reached/)
  assert.match(text, /1\. haiku\/low: FAIL tests fail/)
  assert.match(text, /2\. haiku\/medium: FAIL tests fail/)
  assert.ok(text.includes(last))
  assert.ok(text.includes('/model-ladder:run fix b'))
  assert.ok(existsSync(last))
  assert.ok(!existsSync(first))
  assert.deepEqual(locks(dir), [])
  assert.equal(read(dir, 'b.py'), 'b = 1\n')
})

test('hard limit (guard off): HANDOFF.md carries the raw message and keeps the unreported worktree of the worker that died', () => {
  const dir = repo()
  write(dir, '.claude/model-ladder.json', JSON.stringify({ usageGuard: { enabled: false } }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'guard off')
  const { runId } = preflight(dir)
  const first = worktree(dir, 'wf_1', { 'b.py': 'b = 3\n' })
  const dying = worktree(dir, 'wf_2', { 'b.py': 'b = 4\n' })
  const reason = "The worker haiku/medium hit Claude's subscription limit (resets 3pm): You've hit your session limit · resets 3pm"
  const result = {
    ...verified(first, []), status: 'USAGE_LIMIT', winner: null,
    attempts: [
      { cell: 'haiku/low', pass: false, reason: 'tests fail', action: 'raise_effort', actionReason: 'r', tokens: 10, worktreePath: first },
      { cell: 'haiku/medium', pass: false, reason: "worker failed: You've hit your session limit · resets 3pm", action: null, actionReason: null, tokens: 0, worktreePath: null },
    ],
    final: { reason, suggestion: 'Run /model-ladder:run again after the limit resets; see HANDOFF.md.' },
  }
  const report = finish(dir, { task: 'fix b', runId, result })
  assert.match(report, /model-ladder ── USAGE_LIMIT/)
  const text = read(dir, '.model-ladder/HANDOFF.md')
  assert.ok(text.includes(reason), text)
  assert.ok(existsSync(dying), 'the attempt that died mid-work is kept')
  assert.ok(existsSync(first), 'the last reported attempt is kept too')
  assert.ok(text.includes(dying.split(/[\\/]/).at(-1)), 'the handoff points at the dying attempt')
  assert.deepEqual(locks(dir), [])
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
  assert.deepEqual(locks(dir), [])
  assert.deepEqual(readdirSync(join(dir, '.model-ladder', 'runs')).filter((f) => !f.endsWith('.lock')), [], 'no per-run files or temporary index left')
})

const excludePath = (dir) => join(dir, git(dir, 'rev-parse', '--git-path', 'info/exclude'))
const excludeLines = (dir) => readFileSync(excludePath(dir), 'utf8').split('\n').filter(Boolean)
const BOTH = ['.model-ladder/', '.claude/worktrees/']
// repo() ignores both paths in .gitignore; these tests need a repo that does not.
function plainRepo() {
  const dir = repo()
  rmSync(join(dir, '.gitignore'))
  git(dir, 'commit', '-q', '-am', 'drop gitignore')
  return dir
}

test('ensureGitExclude writes both lines once, creating info/, and repeat calls add nothing', async () => {
  const { ensureGitExclude } = await import('../../scripts/common.mjs')
  const dir = plainRepo()
  rmSync(dirname(excludePath(dir)), { recursive: true, force: true })
  ensureGitExclude(dir)
  assert.deepEqual(excludeLines(dir), BOTH)
  ensureGitExclude(dir)
  assert.deepEqual(excludeLines(dir), BOTH)
})

test('ensureGitExclude keeps existing lines and does not duplicate them', async () => {
  const { ensureGitExclude } = await import('../../scripts/common.mjs')
  const dir = plainRepo()
  mkdirSync(dirname(excludePath(dir)), { recursive: true })
  writeFileSync(excludePath(dir), '*.log\n.model-ladder/')
  ensureGitExclude(dir)
  assert.deepEqual(excludeLines(dir), ['*.log', '.model-ladder/', '.claude/worktrees/'])
})

test('ensureGitExclude skips patterns .gitignore already covers', async () => {
  const { ensureGitExclude } = await import('../../scripts/common.mjs')
  const dir = repo()
  write(dir, '.gitignore', '.model-ladder/\n.claude/worktrees/\n')
  ensureGitExclude(dir)
  assert.ok(!existsSync(excludePath(dir)) || !/model-ladder|worktrees/.test(readFileSync(excludePath(dir), 'utf8')))
})

test('preflight leaves both lines in info/exclude', () => {
  const dir = plainRepo()
  assert.equal(preflight(dir).status, 'READY')
  assert.deepEqual(excludeLines(dir).filter((l) => BOTH.includes(l)), BOTH)
})
