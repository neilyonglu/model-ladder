
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

// Orchestration re-reads the caller's context on every turn; past this size a small task costs
// less done directly. Provisional: see DESIGN.md › Ladder or direct.
const LARGE_CONTEXT = 300000

function isDirect(small, contextTokens, forceLadder) {
  return !forceLadder && small && (contextTokens ?? 0) > LARGE_CONTEXT
}

function isCell(choice, tiers) {
  return tiers.some((tier) => tier.model === choice?.model && tier.efforts.includes(choice?.effort))
}

export { legalMoves, defaultMove, pickMove, isCell, protectedPatterns, ARTIFACTS }
