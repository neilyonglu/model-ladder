import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { durationForecast, remainingForecast, consumptionEvidence, assessUsage, calibrationError } from '../../scripts/ladder-rules.mjs'
import { routeForecast } from '../../scripts/forecast.mjs'

const now = 10000000
const route = { estimatedMinutes: 10, optimisticMinutes: 5, pessimisticMinutes: 30 }
const sample = (overrides = {}) => ({ forecast: { version: 1, key: 'k', routerMinutes: 10,
  startedAt: now - 600000,
  actual: { status: 'VERIFIED', completed: true, censored: false, endedAt: now, durationMs: 600000 },
  phases: [{ phase: 'route', model: 'cheap', effort: 'low', complete: true, elapsedMs: 100000 }], ...overrides } })

test('full duration starts with an honest uncalibrated router range and preserves unknown bounds', () => {
  const f = durationForecast('k', route, [], now)
  assert.equal(f.optimistic, 300000)
  assert.equal(f.mostLikely, 600000)
  assert.equal(f.pessimistic, 1800000)
  assert.equal(f.sampleCount, 0)
  assert.equal(f.provenance, 'router-judgment')
  assert.equal(durationForecast('k', { estimatedMinutes: 5 }, [], now).pessimistic, null)
  assert.equal(durationForecast('k', { ...route, optimisticMinutes: 20 }, [], now).optimistic, null)
})

test('comparable recent completed runs calibrate router error including full retry duration', () => {
  const rows = [sample(), sample({ actual: { ...sample().forecast.actual, durationMs: 1200000 } })]
  const f = durationForecast('k', { estimatedMinutes: 20 }, rows, now)
  assert.equal(f.sampleCount, 2)
  assert.equal(f.optimistic, 1200000)
  assert.equal(f.pessimistic, 2400000)
  assert.equal(f.provenance, 'observed-router-error-ratios')
  assert.deepEqual(calibrationError(f, 3000000), { signedMs: 600000, absoluteMs: 600000, withinRange: false })
})

test('legacy, failed, interrupted, future, stale and unrelated histories are not calibration', () => {
  const actual = sample().forecast.actual
  const rows = [null, { status: 'VERIFIED' }, sample({ key: 'other' }), sample({ actual: { ...actual, status: 'FAILED' } }),
    sample({ actual: { ...actual, censored: true } }), sample({ actual: { ...actual, completed: false } }),
    sample({ actual: { ...actual, endedAt: now + 1 } }), sample({ actual: { ...actual, endedAt: now - 91 * 86400000 } })]
  assert.equal(durationForecast('k', route, rows, now).sampleCount, 0)
})

test('remaining estimates update at matching model/effort boundaries and expose unobserved retries', () => {
  const f = sample().forecast
  f.original = durationForecast('k', route, [], now)
  assert.equal(remainingForecast(f, [sample()], now).mostLikely, 500000)
  assert.equal(remainingForecast(f, [], now).mostLikely, null)
  f.phases.push({ phase: 'diagnose', model: 'cheap', effort: 'low', complete: true })
  assert.equal(remainingForecast(f, [], now).mostLikely, null)
  assert.match(remainingForecast(f, [], now).reason, /retry/)
})

test('failed phase outcomes cannot borrow a successful phase remainder', () => {
  const state = sample().forecast
  state.phases[0].pass = false
  state.original = durationForecast('k', route, [], now)
  const successful = sample()
  successful.forecast.phases[0].pass = true
  assert.equal(remainingForecast(state, [successful], now).mostLikely, null)
  assert.match(remainingForecast(state, [successful], now).reason, /retry/)
})

const consumption = () => sample({
  attribution: { exclusive: true, source: 'provider-run-attribution', accountId: 'test' },
  usageStart: { accountId: 'test', sampledAt: now - 600000, source: 'account', windows: { five_hour: { used: 20, resetsAt: now + 3600000 } } },
  usageEnd: { accountId: 'test', sampledAt: now, source: 'account', windows: { five_hour: { used: 30, resetsAt: now + 3600000 } } },
}).forecast

test('only attributable fresh same-reset consumption is clean evidence', () => {
  assert.equal(consumptionEvidence(consumption(), 'five_hour').value, 10)
  const cases = [
    (f) => { delete f.attribution },
    (f) => { f.attribution.exclusive = false },
    (f) => { f.concurrentAccountActivity = true },
    (f) => { f.usageEnd.accountId = 'other-account' },
    (f) => { f.usageEnd.windows.five_hour.used = 10 },
    (f) => { f.usageStart.windows.five_hour.resetsAt++ },
    (f) => { f.usageStart.sampledAt -= 900001 },
    (f) => { f.usageEnd.sampledAt-- },
    (f) => { f.usageEnd.source = 'other-account' },
    (f) => { f.actual.status = 'FAILED' },
    (f) => { f.actual.censored = true },
    (f) => { f.usageEnd.windows.five_hour.resetsAt = now - 1 },
  ]
  for (const mutate of cases) {
    const f = consumption(); mutate(f)
    assert.equal(consumptionEvidence(f, 'five_hour').value, undefined)
    assert.ok(consumptionEvidence(f, 'five_hour').reason)
  }
})

test('each window compares observed percentage points with its guard and subscription headroom', () => {
  const current = { accountId: 'test', sampledAt: now, windows: { five_hour: { used: 85, resetsAt: now + 3600000 }, seven_day: { used: 10, resetsAt: now + 86400000 } } }
  const rows = [{ forecast: consumption() }]
  let result = assessUsage('k', rows, current, { enabled: true, threshold: 90 }, now)
  assert.equal(result.five_hour.status, 'insufficient')
  assert.equal(result.five_hour.guardHeadroom, 5)
  assert.equal(result.five_hour.estimate.mostLikely, 10)
  assert.equal(result.seven_day.status, 'unknown')
  assert.equal(assessUsage('k', rows, current, { enabled: false, threshold: 90 }, now).five_hour.status, 'sufficient')
  assert.equal(assessUsage('k', rows, current, {}, now, { pessimistic: 7200000 }).five_hour.status, 'unknown')
  const second = consumption(); second.usageEnd.windows.five_hour.used = 40
  current.windows.five_hour.used = 75
  result = assessUsage('k', [...rows, { forecast: second }], current, { enabled: true, threshold: 90 }, now)
  assert.equal(result.five_hour.status, 'at-risk')
  current.windows.five_hour.resetsAt = now + 10
  assert.match(assessUsage('k', rows, current, {}, now).five_hour.reasons[0], /reset/)
  current.sampledAt = now - 900001
  assert.equal(assessUsage('k', rows, current, {}, now).five_hour.status, 'unknown')
})

test('tokens and minutes alone never imply subscription sufficiency', () => {
  const current = { accountId: 'test', sampledAt: now, windows: { five_hour: { used: 10, resetsAt: now + 3600000 } } }
  const rows = [sample({ tokens: 100, routerMinutes: 1 })]
  const r = assessUsage('k', rows, current, { enabled: true, threshold: 90 }, now).five_hour
  assert.equal(r.status, 'unknown')
  assert.equal(r.estimate.sampleCount, 0)
  assert.equal(r.estimate.pessimistic, null)
  assert.match(r.reasons.join(' '), /attributable/)
})

test('continuations preserve the earlier original and never reuse a full-run estimate as remaining work', () => {
  const previousOriginal = durationForecast('k', route, [], now)
  const state = { runtime: 'codex', config: {}, continuation: 'resume', previousOriginal }
  routeForecast(state, { ...route, model: 'cheap', effort: 'low' }, 'test', [], now)
  assert.equal(state.original.mostLikely, null)
  assert.equal(state.original.provenance, 'insufficient-data')
  assert.deepEqual(state.previousOriginal, previousOriginal)
  const full = { runtime: 'codex', config: {} }
  routeForecast(full, { ...route, model: 'cheap', effort: 'low' }, 'test', [], now)
  assert.notEqual(full.key, state.key)
})
