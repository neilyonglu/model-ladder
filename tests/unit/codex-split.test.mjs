import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { runLadder, loadConfig } from '../../scripts/codex-run.mjs'
import { routeForecast } from '../../scripts/forecast.mjs'
import { artifactDir } from '../../scripts/common.mjs'

const dirs = []
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'ladder-no-usage-'))
after(() => { for (const dir of dirs) { rmSync(artifactDir(dir), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) } })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fake = fileURLToPath(new URL('../helpers/fake-codex.mjs', import.meta.url))
const PARTS = [{ task: 'Fix the greeting', scope: ['greeting.mjs'] }, { task: 'Add a check', scope: ['tests/check.test.mjs'] }]
function fixture(scenario, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-split-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 't@example.test')
  git(dir, 'config', 'core.autocrlf', 'false')
  const write = (file, value) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), value) }
  write('.gitignore', '.model-ladder/\n')
  write('greeting.mjs', 'export default "Wellcome"\n')
  write('tests/check.test.mjs', 'import assert from "node:assert/strict"\nimport greeting from "../greeting.mjs"\nassert.equal(greeting,"Welcome")\n')
  write('scenario.json', JSON.stringify(scenario))
  write('.codex/model-ladder.json', JSON.stringify({
    router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' },
    tiers: [{ model: 'cheap', efforts: ['low', 'medium', 'high'], maxEffortJump: 1 }, { model: 'strong', efforts: ['low', 'high'], maxEffortJump: 1 }],
    verify: 'node --test tests/check.test.mjs', maxAttempts: 3, ...overrides,
  }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}
const run = (cwd, input = {}, extra = {}) => runLadder({ task: 'Fix greeting typo', ...input }, { cwd, executable: { command: process.execPath, prefixArgs: [fake, cwd] }, ...extra })

test('a long task runs and stores a full forecast, boundaries and actual phase usage', async () => {
  const dir = fixture({ estimatedMinutes: 35, optimisticMinutes: 20, pessimisticMinutes: 60, split: PARTS })
  const result = await run(dir)
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(result.attempts.length, 1)
  assert.equal(result.forecast.original.mostLikely, 35 * 60000)
  assert.equal(result.forecast.original.optimistic, 20 * 60000)
  assert.equal(result.forecast.original.pessimistic, 60 * 60000)
  assert.deepEqual(result.forecast.phases.map((p) => p.phase), ['route', 'worker', 'verify-command', 'verify'])
  assert.equal(result.forecast.phases[1].model, 'cheap')
  assert.equal(result.forecast.phases[1].effort, 'low')
  assert.equal(result.forecast.phases[1].tokens[0].input_tokens, 20)
  assert.ok(result.forecast.phases.every((p) => p.durationMs >= 0 && p.complete))
  assert.ok(result.forecast.updates.some((u) => u.boundary === 'worker'))
  assert.equal(result.forecast.actual.censored, false)
  assert.equal(result.forecast.current.remaining.mostLikely, 0)
  assert.equal(typeof result.forecast.error.signedMs, 'number')
  const saved = JSON.parse(readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim())
  assert.deepEqual(saved.forecast.original, result.forecast.original)
  const live = JSON.parse(readFileSync(join(dir, '.model-ladder/live.json'), 'utf8'))
  assert.deepEqual(live.forecast, saved.forecast)
  const calls = readFileSync(join(dir, '.model-ladder/fake-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls.map((c) => c.phase), ['route', 'worker', 'verify'])
  assert.match(calls[0].prompt, /independent verification and diagnosis\/retry risk/)
  writeFileSync(join(dir, 'greeting.mjs'), 'export default "Wellcome"\n')
  const next = await run(dir)
  assert.equal(next.status, 'VERIFIED', JSON.stringify(next))
  assert.equal(next.forecast.original.sampleCount, 1)
  assert.equal(next.forecast.original.provenance, 'observed-router-error-ratios')
  assert.ok(next.forecast.updates.some((u) => u.remaining.provenance === 'observed-phase-remainder'))
  const rows = readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows[0].forecast.original, result.forecast.original)
})

test('obsolete split settings and answers do not gate execution', async () => {
  for (const split_minutes of [10, 'off', 'obsolete']) {
    const result = await run(fixture({ estimatedMinutes: 500, split: PARTS }, { split_minutes }), { acceptSplit: true })
    assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
    assert.equal(result.splitSuggestion, undefined)
  }
})

test('retry boundaries and terminal failures remain distinct from interrupted data', async () => {
  const retry = await run(fixture({ failFirst: true, estimatedMinutes: 40 }))
  assert.equal(retry.status, 'VERIFIED')
  assert.equal(retry.forecast.phases.filter((p) => p.phase === 'worker').length, 2)
  assert.ok(retry.forecast.updates.some((u) => u.boundary === 'diagnose' && u.remaining.mostLikely === null))
  const dir = fixture({ environment: 'worker' })
  const stopped = await run(dir)
  assert.equal(stopped.status, 'STOPPED')
  assert.equal(stopped.forecast.actual.censored, true)
  assert.equal(stopped.forecast.error, null)
  assert.equal(stopped.forecast.phases.at(-1).complete, false)
  assert.equal(stopped.forecast.phases.at(-1).tokens, null)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.model-ladder/history.jsonl'), 'utf8').trim()).forecast, stopped.forecast)
})

test('the codex router prompt asks for targeted tests and judges only from the task and repo', async () => {
  const dir = fixture({ estimatedMinutes: 1, split: [] })
  await run(dir)
  const calls = readFileSync(join(dir, '.model-ladder', 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const prompt = calls.find((c) => c.phase === 'route').prompt
  assert.match(prompt, /only targeted, fast existing tests/)
  assert.match(prompt, /leave the full suite to CI/)
  assert.match(prompt, /Never run node --test <directory>/)
  assert.match(prompt, /task text already gives a verify command, use it as given/)
  assert.match(prompt, /Judge only from the TASK text and the repo contents/)
  assert.match(prompt, /Do not read session transcripts or any file outside the repo/)
  assert.match(prompt, /Numbers in the TASK \(1, 2, 3\.\.\.\) refer only to items within that task/)
})

// Usage-risk confirmation. Comparable history rows carry attributable account samples, so assessUsage in
// forecast.mjs can judge a window; the current sample comes in through options.usageSnapshot.
const ACCOUNT = 'acct-test'
const HOUR = 3600000
const sampled = (used) => () => ({ accountId: ACCOUNT, sampledAt: Date.now(), source: 'test-account', windows: { five_hour: { used, resetsAt: Date.now() + 3 * HOUR } } })
function keyFor(dir, continuation) {
  const { router, verifier, maxAttempts } = loadConfig(dir)
  const state = { runtime: 'codex', config: { router, verifier, maxAttempts }, ...(continuation && { continuation }) }
  routeForecast(state, { start: { model: 'cheap', effort: 'low' }, estimatedMinutes: 5, optimisticMinutes: 5, pessimisticMinutes: 5, readOnly: false, allowTests: false }, 'node --test tests/check.test.mjs', [])
  return state.key
}
// One completed run per entry, each observed to consume that many percentage points of the five-hour window.
function seedHistory(dir, points, continuation = null) {
  const now = Date.now(), startedAt = now - 120000, endedAt = now - 60000
  const sample = (sampledAt, used) => ({ accountId: ACCOUNT, sampledAt, source: 'test-account', windows: { five_hour: { used, resetsAt: now + 3 * HOUR } } })
  mkdirSync(join(dir, '.model-ladder'), { recursive: true })
  for (const p of points) appendFileSync(join(dir, '.model-ladder/history.jsonl'), `${JSON.stringify({ runtime: 'codex', status: 'VERIFIED', forecast: {
    version: 1, key: keyFor(dir, continuation), startedAt, routerMinutes: 5, phases: [],
    actual: { status: 'VERIFIED', completed: true, censored: false, durationMs: endedAt - startedAt, endedAt },
    attribution: { exclusive: true, source: 'test', accountId: ACCOUNT }, usageStart: sample(startedAt, 20), usageEnd: sample(endedAt, 20 + p),
  } })}\n`)
}
const phases = (dir) => existsSync(join(dir, '.model-ladder/fake-calls.jsonl')) ? readFileSync(join(dir, '.model-ladder/fake-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).phase) : []
const routed = (result) => result.forecast.updates.find((u) => u.boundary === 'routed').usage.five_hour.status
const released = (dir) => {
  assert.deepEqual(existsSync(join(dir, '.model-ladder/runs')) ? readdirSync(join(dir, '.model-ladder/runs')).filter((f) => f.endsWith('.json')) : [], [])
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1)
}

test('a forecast short on usage asks once with evidence before any worker; decline leaves nothing behind', async () => {
  for (const [points, status] of [[[10], 'insufficient'], [[4, 10], 'at-risk']]) {
    const dir = fixture({})
    seedHistory(dir, points)
    const result = await run(dir, {}, { usageSnapshot: sampled(85) })
    assert.equal(result.status, 'NEEDS_INPUT', JSON.stringify(result))
    assert.equal(result.reason, 'USAGE_RISK')
    assert.deepEqual(phases(dir), ['route'])
    assert.equal(result.usageRisk.windows.length, 1)
    const [window] = result.usageRisk.windows
    assert.equal(window.window, 'five_hour')
    assert.equal(window.status, status)
    assert.equal(window.used, 85)
    assert.equal(window.need.optimistic, points[0])
    assert.equal(window.need.pessimistic, 10)
    assert.equal(window.available, 5)
    assert.ok(window.resetsAt > Date.now())
    assert.match(result.message, /five_hour .*85% used.*acceptUsageRisk true/)
    // Declining means not rerunning: no lock, worktree or change remains.
    released(dir)
    assert.match(readFileSync(join(dir, 'greeting.mjs'), 'utf8'), /Wellcome/)
    assert.equal(git(dir, 'status', '--porcelain'), '')
  }
})

test('acceptUsageRisk true proceeds to the worker and independent verification', async () => {
  const dir = fixture({})
  seedHistory(dir, [10])
  assert.equal((await run(dir, { acceptUsageRisk: 'yes' })).status, 'ERROR')
  const result = await run(dir, { acceptUsageRisk: true }, { usageSnapshot: sampled(85) })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  assert.equal(routed(result), 'insufficient')
  assert.deepEqual(phases(dir), ['route', 'worker', 'verify'])
})

test('sufficient, unknown or missing usage data never asks', async () => {
  const dir = fixture({})
  seedHistory(dir, [10])
  const sufficient = await run(dir, {}, { usageSnapshot: sampled(50) })
  assert.equal(sufficient.status, 'VERIFIED', JSON.stringify(sufficient))
  assert.equal(routed(sufficient), 'sufficient')
  writeFileSync(join(dir, 'greeting.mjs'), 'export default "Wellcome"\n')
  // Without an account identity the sample's consumption is not attributable: unknown.
  const unattributed = await run(dir, {}, { usageSnapshot: () => ({ ...sampled(85)(), accountId: undefined }) })
  assert.equal(unattributed.status, 'VERIFIED', JSON.stringify(unattributed))
  assert.equal(routed(unattributed), 'unknown')
  const missing = await run(fixture({}), {}, { usageSnapshot: () => ({ sampledAt: null, windows: {}, reason: 'No sample' }) })
  assert.equal(missing.status, 'VERIFIED', JSON.stringify(missing))
  assert.equal(routed(missing), 'unknown')
})

test('accepting the forecast never bypasses usageGuard', async () => {
  const dir = fixture({})
  seedHistory(dir, [10])
  const home = mkdtempSync(join(tmpdir(), 'ml-guard-home-'))
  dirs.push(home)
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    // Usage rises past the default 90% guard while the router runs.
    const result = await run(dir, { acceptUsageRisk: true }, { usageSnapshot: () => {
      mkdirSync(join(home, 'sessions'), { recursive: true })
      writeFileSync(join(home, 'sessions/s.jsonl'), JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 95, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 } } } }) + '\n')
      return sampled(95)()
    } })
    assert.equal(result.status, 'STOPPED', JSON.stringify(result))
    assert.equal(result.errorCode, 'USAGE_LIMIT')
    assert.deepEqual(phases(dir), ['route'])
    released(dir)
  } finally { process.env.CODEX_HOME = previous }
})

test('a resume reuses the checkpoint route and does not ask again for the accepted forecast', async () => {
  const dir = fixture({ delay: 10000, delayFirst: true }, { timeoutMs: 2000 })
  seedHistory(dir, [10])
  seedHistory(dir, [10], 'resume')
  assert.equal((await run(dir, {}, { usageSnapshot: sampled(85) })).reason, 'USAGE_RISK')
  const stopped = await run(dir, { acceptUsageRisk: true }, { usageSnapshot: sampled(85) })
  assert.equal(stopped.status, 'STOPPED', JSON.stringify(stopped))
  assert.equal(stopped.errorCode, 'TIMEOUT')
  assert.equal(JSON.parse(readFileSync(stopped.checkpointPath, 'utf8')).acceptedUsageRisk, true)
  const before = phases(dir).length
  const resumed = await run(dir, { resumeRun: stopped.resumeRun }, { usageSnapshot: sampled(85) })
  assert.equal(resumed.status, 'VERIFIED', JSON.stringify(resumed))
  assert.equal(resumed.forecast.continuation, 'resume')
  assert.equal(routed(resumed), 'insufficient')
  assert.deepEqual(phases(dir).slice(before), ['worker', 'verify'])
  git(dir, 'worktree', 'remove', '--force', stopped.worktreePath)
  released(dir)
})
