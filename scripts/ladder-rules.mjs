
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

// The router's wall-clock estimate (start to verified, test runs included) against the person's limit in minutes
// (split_minutes, or "off"). Equal to the limit is fine. The caller skips this for forceLadder, DIRECT and acceptSplit:false.
const DEFAULT_SPLIT_MINUTES = 20

function splitSuggestion(estimatedMinutes, split, limit = DEFAULT_SPLIT_MINUTES) {
  if (!(typeof limit === 'number' && limit > 0)) return null
  if (!(typeof estimatedMinutes === 'number' && estimatedMinutes > limit) || !Array.isArray(split) || !split.length) return null
  return { estimatedMinutes, limit, parts: split }
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

export { legalMoves, defaultMove, pickMove, isCell, protectedPatterns, ARTIFACTS }
