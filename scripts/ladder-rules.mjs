
// Files that running the verify step itself rewrites. Never a sign the worker cheated.
const ARTIFACTS = [
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.pytest_cache/**',
  '**/node_modules/**',
  '**/target/**',
  '**/build/**',
  '**/dist/**',
  '**/coverage/**',
]

// `protection` comes from scripts/preflight.mjs: { always, tests }.
function protectedPatterns(protection, allowTests) {
  return [...(allowTests ? [] : protection.tests), ...protection.always]
}

function legalMoves(cell, tiers) {
  const t = tiers.findIndex((tier) => tier.model === cell.model)
  const tier = tiers[t]
  const e = tier.efforts.indexOf(cell.effort)
  const higherEffort = tier.efforts
    .slice(e + 1, e + 1 + tier.maxEffortJump)
    .map((effort) => ({ model: tier.model, effort }))
  const next = tiers[t + 1]
  const nextTier = next ? next.efforts.map((effort) => ({ model: next.model, effort })) : []
  return [...higherEffort, ...nextTier]
}

// Next effort in the same tier, else the lowest effort of the next tier.
function defaultMove(cell, tiers) {
  return legalMoves(cell, tiers)[0] ?? null
}

function pickMove(choice, cell, tiers) {
  const moves = legalMoves(cell, tiers)
  const match = moves.find((m) => m.model === choice?.model && m.effort === choice?.effort)
  return match ?? moves[0] ?? null
}

// Orchestration re-reads the caller's context on every turn; once the session holds this percentage of its
// context window, a small task costs less done directly. "off" never goes direct. Provisional: see DESIGN.md.
const DEFAULT_WINDOW = 200000
const DEFAULT_DIRECT_THRESHOLD = 30

function contextPercent(contextTokens, contextWindow) {
  return ((contextTokens ?? 0) / (contextWindow > 0 ? contextWindow : DEFAULT_WINDOW)) * 100
}

function isDirect(small, contextTokens, forceLadder, contextWindow, directThreshold = DEFAULT_DIRECT_THRESHOLD) {
  if (forceLadder || !small || directThreshold === 'off') return false
  return contextPercent(contextTokens, contextWindow) >= directThreshold
}

const FORECAST_MAX_AGE = 90 * 86400000
const range = (values, provenance) => {
  const sorted = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  return { optimistic: sorted[0] ?? null, mostLikely: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    pessimistic: sorted.at(-1) ?? null, provenance, sampleCount: sorted.length }
}

function comparableForecasts(key, rows, now) {
  return rows.map((r) => r?.forecast).filter((f) => f?.version === 1 && f.key === key &&
    f.actual?.status === 'VERIFIED' && f.actual.completed === true && f.actual.censored === false &&
    Number.isFinite(f.actual.durationMs) && f.actual.durationMs >= 0 && Number.isFinite(f.startedAt) && f.actual.endedAt >= f.startedAt &&
    Number.isFinite(f.actual.endedAt) && f.actual.endedAt <= now && now - f.actual.endedAt <= FORECAST_MAX_AGE)
}

function durationForecast(key, route, rows, now) {
  const samples = comparableForecasts(key, rows, now).filter((f) => f.routerMinutes > 0)
  const point = route.estimatedMinutes > 0 ? route.estimatedMinutes * 60000 : null
  if (samples.length && point !== null) {
    return { ...range(samples.map((f) => point * f.actual.durationMs / (f.routerMinutes * 60000)), 'observed-router-error-ratios'),
      unit: 'ms', retryEvidence: { sampleCount: samples.length, retriedRuns: samples.filter((f) => f.phases?.filter((p) => p.phase === 'worker').length > 1).length },
      reason: 'Empirical min/median/max of comparable completed runs; not a confidence interval. Includes routing, work, tests, verification and observed retries.' }
  }
  const lo = route.optimisticMinutes * 60000, hi = route.pessimisticMinutes * 60000
  const valid = point !== null && Number.isFinite(lo) && lo > 0 && lo <= point && Number.isFinite(hi) && hi >= point
  return { optimistic: valid ? lo : null, mostLikely: point, pessimistic: valid ? hi : null, unit: 'ms',
    provenance: 'router-judgment', sampleCount: 0,
    reason: valid ? 'Uncalibrated router judgment, including all phases and retry risk.' : 'Insufficient history and no valid router range; bounds unknown.' }
}

function remainingForecast(state, rows, now) {
  const observed = state.phases
  const prefix = observed.map((p) => `${p.phase}/${p.model}/${p.effort}/${p.complete}/${p.pass}`)
  const samples = comparableForecasts(state.key, rows, now).filter((f) => prefix.every((p, i) => {
    const phase = f.phases?.[i]
    return phase && `${phase.phase}/${phase.model}/${phase.effort}/${phase.complete}/${phase.pass}` === p
  }))
  if (prefix.length && samples.length) {
    const observed = samples.map((f) => f.actual.durationMs - f.phases[prefix.length - 1].elapsedMs)
    return { ...range(observed, 'observed-phase-remainder'), unit: 'ms' }
  }
  const elapsed = Math.max(0, now - state.startedAt)
  const original = state.original
  const retry = observed.filter((p) => p.phase === 'worker').length > 1 || observed.some((p) => p.phase === 'diagnose' || p.pass === false || !p.complete)
  const overdue = original?.pessimistic !== null && elapsed > original?.pessimistic
  if (!original || retry || overdue) return { ...range([], 'insufficient-data'), unit: 'ms', reason: retry ? 'No comparable observed retry remainder' : 'No usable remaining forecast (missing or exceeded bounds)' }
  return { ...original, ...Object.fromEntries(['optimistic', 'mostLikely', 'pessimistic'].map((k) => [k, original[k] === null || k === 'mostLikely' && elapsed >= original[k] ? null : Math.max(0, original[k] - elapsed)])), provenance: 'elapsed-original-forecast' }
}

function calibrationError(original, actualMs) {
  if (!original || !Number.isFinite(actualMs)) return null
  return { signedMs: original.mostLikely === null ? null : actualMs - original.mostLikely,
    absoluteMs: original.mostLikely === null ? null : Math.abs(actualMs - original.mostLikely),
    withinRange: original.optimistic === null || original.pessimistic === null ? null : actualMs >= original.optimistic && actualMs <= original.pessimistic }
}

function consumptionEvidence(f, window) {
  const start = f.usageStart, end = f.usageEnd
  const a = start?.windows?.[window], b = end?.windows?.[window]
  if (f.actual?.status !== 'VERIFIED' || f.actual.censored || !f.actual.completed) return { reason: 'Run was not successfully completed' }
  if (f.concurrentAccountActivity === true) return { reason: 'Concurrent account activity contaminated this observation' }
  if (f.attribution?.exclusive !== true || !f.attribution?.source) return { reason: 'Concurrent account activity cannot be excluded; consumption is not attributable' }
  if (!start?.accountId || start.accountId !== end?.accountId || start.accountId !== f.attribution.accountId) return { reason: 'Subscription account identity is missing or changed' }
  if (![start?.sampledAt, end?.sampledAt, a?.used, b?.used, a?.resetsAt, b?.resetsAt].every(Number.isFinite)) return { reason: 'Missing subscription observations or reset identity' }
  if (start.source !== end.source) return { reason: 'Subscription sample source changed' }
  if (a.used < 0 || b.used > 100 || b.used < a.used) return { reason: 'Invalid or decreasing percentages' }
  if (start.sampledAt > f.startedAt || f.startedAt - start.sampledAt > 900000 || end.sampledAt < f.actual.endedAt || end.sampledAt - f.actual.endedAt > 900000 || end.sampledAt <= start.sampledAt) return { reason: 'Stale or incomplete boundary observations' }
  if (a.resetsAt !== b.resetsAt || a.resetsAt <= end.sampledAt) return { reason: 'Subscription window reset during observation' }
  return { value: b.used - a.used }
}

function assessUsage(key, rows, current, guard, now, duration = null) {
  const samples = comparableForecasts(key, rows, now)
  const names = new Set([...Object.keys(current?.windows ?? {}), ...samples.flatMap((f) => Object.keys(f.usageStart?.windows ?? {}))])
  if (!names.size) { names.add('five_hour'); names.add('seven_day') }
  return Object.fromEntries([...names].map((name) => {
    const window = current?.windows?.[name]
    const fresh = Number.isFinite(current?.sampledAt) && current.sampledAt <= now && now - current.sampledAt <= 900000 && window?.resetsAt > now && Number.isFinite(window?.used) && window.used >= 0 && window.used <= 100
    const evidence = samples.map((f) => current?.accountId && current.accountId === f.usageStart?.accountId ? consumptionEvidence(f, name) : { reason: 'No comparable subscription account identity' })
    const estimate = { ...range(evidence.map((e) => e.value), 'observed-subscription-percentage-points'), unit: 'percentage-points' }
    const headroom = fresh ? 100 - window.used : null
    const guardHeadroom = fresh && guard?.enabled && Number.isFinite(guard.threshold) ? guard.threshold - window.used : null
    const available = guardHeadroom === null ? headroom : Math.min(headroom, guardHeadroom)
    const crossing = fresh && (samples.some((f) => now + f.actual.durationMs >= window.resetsAt) || Number.isFinite(duration?.pessimistic) && now + duration.pessimistic >= window.resetsAt)
    const usable = fresh && !crossing && estimate.sampleCount > 0
    const status = !usable ? 'unknown' : estimate.pessimistic <= available ? 'sufficient' : estimate.optimistic > available ? 'insufficient' : 'at-risk'
    return [name, { status, headroom, guardHeadroom, estimate, scope: 'full-run-consumption',
      reasons: !fresh ? ['Missing, stale or expired current window'] : crossing ? ['Forecast may cross this window reset'] : !estimate.sampleCount ? [...new Set(evidence.map((e) => e.reason).concat('Insufficient attributable comparable consumption data'))] : [] }]
  }))
}

// The one pre-worker question: a window assessUsage already judged short. Unknown or missing data never asks.
// `current` is a forecast update ({ usage, observation }); resetsAt is epoch ms, formatted by the caller.
function usageRisk(current) {
  const windows = Object.entries(current?.usage ?? {}).filter(([, a]) => a?.status === 'insufficient' || a?.status === 'at-risk').map(([window, a]) => {
    const seen = current.observation?.windows?.[window]
    const available = [a.headroom, a.guardHeadroom].filter(Number.isFinite)
    return { window, status: a.status, used: seen?.used ?? null, resetsAt: seen?.resetsAt ?? null,
      need: { optimistic: a.estimate?.optimistic ?? null, mostLikely: a.estimate?.mostLikely ?? null, pessimistic: a.estimate?.pessimistic ?? null, unit: 'percentage-points' },
      available: available.length ? Math.min(...available) : null, headroom: a.headroom ?? null, guardHeadroom: a.guardHeadroom ?? null }
  })
  if (!windows.length) return null
  const line = (w) => `${w.window} ${w.status}: ${w.used ?? '?'}% used, forecast needs ${w.need.optimistic ?? '?'}-${w.need.pessimistic ?? '?'} points, ${w.available ?? '?'} available`
  return { reason: 'USAGE_RISK', windows, question: `The usage forecast says this run may exceed the usage available (${windows.map(line).join('; ')}). Continue anyway?` }
}

function isCell(choice, tiers) {
  return tiers.some((tier) => tier.model === choice?.model && tier.efforts.includes(choice?.effort))
}

// The verifier's usage field: the output of scripts/usage-guard.mjs, the settings and usage as they are at
// this check, e.g. {"enabled":true,"threshold":90,"usage":93}. It stops the run only when the person has the
// guard on and a known usage is at or above their threshold; anything unreadable never stops it.
function guardStop(raw) {
  let state
  try { state = JSON.parse(String(raw ?? '')) } catch { return null }
  const stops = state?.enabled === true && typeof state.usage === 'number' && typeof state.threshold === 'number' && state.usage >= state.threshold
  return stops ? state : null
}

// An agent that failed because Claude's subscription limit is spent, as opposed to failing at the task.
// Another agent would fail the same way until the reset, so the run stops and hands off. Independent of usageGuard.
const HARD_LIMIT = /hit your (?:session |weekly |daily |opus |usage |5-hour )?limit|usage limit|rate[ _-]?limit|limit reached|too many requests|out of (?:extra )?usage|\b429\b/i

function hardLimit(text) {
  const message = String(text ?? '').trim()
  if (!HARD_LIMIT.test(message)) return null
  const resets = message.match(/\bresets?\s+(?:at\s+|in\s+)?([^·\n;|]+)/i)?.[1]?.replace(/[\s.]+$/, '') || null
  return { message, resets }
}

export { legalMoves, defaultMove, pickMove, isCell, isDirect, protectedPatterns, ARTIFACTS, durationForecast, remainingForecast, assessUsage, consumptionEvidence, calibrationError, usageRisk }
