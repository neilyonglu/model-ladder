export const meta = {
  name: 'ladder',
  description: 'Internal engine of model-ladder. Use /model-ladder:run <task> instead.',
  whenToUse: 'Never directly: /model-ladder:run prepares its args, applies its result and cleans up after it.',
}

// Workflow scripts cannot import, so the pure helpers live here.
// tests/unit evaluates the code between the <pure> markers.
// <pure>
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
// </pure>

const VERIFY_SKILL = "Follow the project's verify skill at .claude/skills/verify/SKILL.md"
const OUTPUT_LINES = 200

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    effort: { type: 'string' },
    reason: { type: 'string' },
    goal: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } },
    verify: { type: ['string', 'null'] },
    acceptance: { type: 'array', items: { type: 'string' } },
    allowTests: { type: 'boolean' },
    allowTestsReason: { type: 'string' },
    question: { type: ['string', 'null'] },
    small: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    smallReason: { type: 'string' },
    estimatedMinutes: { type: 'integer' },
    optimisticMinutes: { type: 'integer' },
    pessimisticMinutes: { type: 'integer' },
  },
  required: ['model', 'effort', 'reason', 'goal', 'scope', 'verify', 'acceptance', 'allowTests', 'allowTestsReason', 'question', 'small', 'smallReason', 'estimatedMinutes', 'optimisticMinutes', 'pessimisticMinutes'],
}

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    worktreePath: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    selfCheck: { type: 'string' },
    blockedReason: { type: ['string', 'null'] },
  },
  required: ['status', 'worktreePath', 'filesChanged', 'summary', 'selfCheck', 'blockedReason'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' },
    output: { type: 'string' },
  },
  required: ['pass', 'reason', 'output'],
}

// preflight always passes usageGuard.command; the verifier runs it last and reports the guard settings and
// subscription usage as they are at that moment (scripts/usage-guard.mjs), so a mid-run change counts.
const verdictSchema = () => (args.usageGuard
  ? { ...VERDICT_SCHEMA, properties: { ...VERDICT_SCHEMA.properties, usage: { type: 'string' } }, required: [...VERDICT_SCHEMA.required, 'usage'] }
  : VERDICT_SCHEMA)

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  properties: {
    action: { enum: ['raise_effort', 'raise_model', 'stop_environment', 'stop_unclear'] },
    model: { type: ['string', 'null'] },
    effort: { type: ['string', 'null'] },
    reason: { type: 'string' },
    hint: { type: 'string' },
  },
  required: ['action', 'model', 'effort', 'reason', 'hint'],
}

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    suggestion: { type: 'string' },
  },
  required: ['reason', 'suggestion'],
}

const label = (cell) => `${cell.model}/${cell.effort}`
const grid = (tiers) => tiers.map((t) => `- ${t.model}: ${t.efforts.join(', ')}`).join('\n')
const bullets = (items) => items.map((i) => `  - ${i}`).join('\n')

// agent() returns null when an agent dies and throws when it cannot produce valid structured
// output. Either way this step failed; the ladder decides what happens next. An agent stopped by Claude's
// subscription limit can also come back with no report but with its last text instead (a string, or an object
// with an error/message field, e.g. "You've hit your 5-hour limit"). `limit` is set when a thrown message or
// that text says the limit is spent (see hardLimit); the ladder then stops and starts no other agent.
function deadText(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') return [result.error, result.message].filter((v) => typeof v === 'string').join('\n')
  return ''
}

async function callAgent(prompt, opts) {
  const before = budget.spent()
  try {
    const result = await agent(prompt, opts)
    if (result && typeof result === 'object' && !Array.isArray(result) && !deadText(result)) {
      return { result, error: null, limit: null, tokens: budget.spent() - before }
    }
    const text = deadText(result).trim()
    const limit = hardLimit(text)
    const error = limit ? `stopped on the usage limit: ${text.slice(0, 200)}` : text ? `returned no report: ${text.slice(0, 200)}` : 'died before reporting'
    return { result: null, error, limit, tokens: budget.spent() - before }
  } catch (e) {
    const message = String(e?.message ?? e)
    return { result: null, error: `failed: ${message.slice(0, 200)}`, limit: hardLimit(message), tokens: budget.spent() - before }
  }
}

// The host measures one real agent per call. Earlier outputs replay locally;
// they never re-spend tokens. No clock, filesystem or tool API in this workflow.
const journal = [...(args?.journal ?? [])]
let replayIndex = args?.plan && journal[0]?.phase === 'route' ? 1 : 0
let executed = false
async function measured(prompt, opts) {
  const phaseName = opts.label.split(' ')[0]
  if (args.telemetry && replayIndex < journal.length) {
    const entry = journal[replayIndex++]
    if (entry.phase !== phaseName || entry.model !== opts.model || entry.effort !== opts.effort) throw new Error('Workflow journal does not match this plan')
    return entry.measurement
  }
  if (args.telemetry && executed) throw { boundary: true }
  executed = true
  const measurement = await callAgent(prompt, opts)
  if (args.telemetry) {
    journal.push({ phase: phaseName, model: opts.model, effort: opts.effort, measurement })
    replayIndex++
  }
  return measurement
}

const LIMIT_SUGGESTION = 'Run /model-ladder:run again after the limit resets; see HANDOFF.md.'
const limitFinal = (who, limit) => ({
  reason: `The ${who} hit Claude's subscription limit${limit.resets ? ` (resets ${limit.resets})` : ''}: ${limit.message}`,
  suggestion: LIMIT_SUGGESTION,
})

async function route() {
  const { task, config } = args
  const verifyKnown = config.verify ? `The project sets the verify command: ${config.verify}` :
    args.hasVerifySkill ? 'The project has a verify skill; set verify to null, it will be used.' :
    'Find the verify command the repo already has (a test suite in pyproject.toml, package.json, Makefile, pom.xml, ...). It must run checks that exist before this task. Never write a new check yourself, not even a one-line assert: that would let you, not the user, define done. Use null if the repo has no tests that cover this task. With no project verify, pick only targeted, fast existing tests that cover this change: list the relevant test files or globs (for example node --test tests/unit/a.test.mjs tests/unit/b.test.mjs, pytest tests/test_x.py, npm test -- path), never the whole suite or a bare directory; leave the full suite to CI. Never run node --test <directory>: Node 24 treats a directory as a module and fails, so list files or use a glob. If the task text already gives a verify command, use it as given.'
  const prompt = `You are the router of model-ladder. Read the task and the repo (read-only), then pick where the work starts.

TASK
${task}

GRID (each tier is stronger than the one above it; effort raises depth within a tier)
${grid(config.tiers)}

Judge only from the TASK text and the repo contents. Do not read session transcripts or any file outside the repo (for example ~/.claude/projects). Numbers in the TASK (1, 2, 3...) refer only to items within that task.

Pick the cheapest cell likely to succeed in one attempt. A failed attempt escalates, so do not start high to be safe; start high only for work that clearly needs it (architecture, hard cross-cutting bugs).

Also return:
- goal: the task as one sentence a stranger could execute.
- scope: files you expect to change.
- verify: ${verifyKnown}
- acceptance: checkable done criteria, one per item. ${args.acceptance?.length ? 'The user already gave them; return them unchanged.' : 'Empty if the verify command alone defines done.'}
- allowTests: true only when the task itself is to write or change tests. A bug fix is not: the tests define the expected behavior.
- question: if the task is too vague to act on (no clear outcome, several very different readings), the one question that would settle it. Otherwise null. A worker would guess, and passing tests would hide the guess.
- small: true when the task touches one or two files and its design is already given (for example "implement this function as described"), so a capable model would finish it in one pass. Otherwise false.
- smallReason: one sentence on why.
- readOnly: true when the task only reads and reports (a review, an analysis, a question) and edits no file. Otherwise false.
- estimatedMinutes (most likely), optimisticMinutes and pessimisticMinutes: positive integer wall-clock minutes for the FULL run, including routing, implementation, worker self-checks, test commands, independent verification, diagnosis and retry risk. Give an honest ordered range, not a guarantee.`
  const { result: r, error, limit, tokens } = await measured(prompt, {
    label: `route ${label(config.router)}`, phase: 'Route', schema: ROUTE_SCHEMA, agentType: 'model-ladder:router', ...config.router,
  })
  if (limit) return { limited: limitFinal('router', limit), routeTokens: tokens }
  if (!r) throw new Error(`model-ladder: the router ${error}`)
  const lowest = { model: config.tiers[0].model, effort: config.tiers[0].efforts[0] }
  const start = isCell(r, config.tiers) ? { model: r.model, effort: r.effort } : lowest
  const verify = config.verify ?? (args.hasVerifySkill ? VERIFY_SKILL : r.verify)
  const acceptance = args.acceptance?.length ? args.acceptance : r.acceptance
  const startReason = isCell(r, config.tiers) ? r.reason : `Router picked ${label(r)}, not in the grid; starting at ${label(lowest)}`
  const direct = isDirect(r.small === true, args.contextTokens, args.forceLadder, args.contextWindow, args.directThreshold)
  return {
    start,
    startReason,
    goal: r.goal,
    scope: r.scope,
    verify,
    acceptance: acceptance.length || !verify ? acceptance : ['The verify command passes'],
    allowTests: r.allowTests,
    allowTestsReason: r.allowTestsReason,
    protected: protectedPatterns(args.protection, r.allowTests),
    question: r.question,
    readOnly: r.readOnly === true,
    direct,
    estimatedMinutes: r.estimatedMinutes,
    optimisticMinutes: r.optimisticMinutes,
    pessimisticMinutes: r.pessimisticMinutes,
    directReason: `${r.smallReason} The calling session holds about ${args.contextTokens} tokens of context, ${Math.round(contextPercent(args.contextTokens, args.contextWindow))}% of a ${args.contextWindow > 0 ? args.contextWindow : DEFAULT_WINDOW}-token window; the DIRECT threshold is ${args.directThreshold === 'off' ? 'off' : `${args.directThreshold ?? DEFAULT_DIRECT_THRESHOLD}%`}.`,
    // Without a verify step the user, not the router, decides what done means.
    needsAcceptance: !verify && !args.acceptance?.length,
    // Built here, not by the skill: the question box shows one flat paragraph, so the list goes in a message.
    acceptanceMessage: `**Ladder start:** ${label(start)} — ${startReason}\n\n**Acceptance criteria (proposed)**\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nTip: run /model-ladder:create-verification-skill to generate .claude/skills/verify/; the ladder will use it automatically next time.`,
    acceptanceQuestion: 'Run with these criteria?',
    routeTokens: tokens,
  }
}

function summarize(attempt, i) {
  return `#${i + 1} ${label(attempt.cell)}: ${attempt.verdict.reason}` +
    (attempt.diagnosis ? ` -> ${attempt.diagnosis.action}: ${attempt.diagnosis.reason}` : '')
}

// A value still holding "${" was never substituted; otherwise preserve the instructions verbatim.
const skillsSection = (v) => {
  if (typeof v !== 'string' || !v.trim() || v.includes('${')) return null
  return `SKILL INSTRUCTIONS\n${v}\n\nInterpret these natural-language instructions in the context of your assigned task and role. Evaluate each condition first, then select only the applicable relevant skills, plugins, slash commands, MCP tools or other capabilities actually available to you. Existing name lists are requests to use those capabilities where relevant. A name may be a skill, a plugin name or an MCP server name (tools named mcp__<server>__*); map it to the matching available capability. Read selected skills' instructions and invoke them with the Skill tool, and call plugin, slash-command and MCP tools directly. If an applicable required capability cannot be found, report it explicitly as a blocker and list the available capabilities you checked; never invent names or claim to have used a capability you did not invoke. Stay within this role's scope, permissions, protected paths and verification rules, even if a capability asks for more. Verifiers only check and report; they never fix code. Never invoke model-ladder skills, workflows or runners, the Workflow tool, or other agents, recursively.`
}

function brief(plan, history, hint) {
  const sections = [
    `GOAL\n  ${plan.goal}`,
    `TASK (as the user wrote it)\n  ${args.task}`,
    `SCOPE\n  ${plan.scope.length ? plan.scope.join(', ') : 'Decide from the code.'}`,
    `ACCEPTANCE\n${bullets(plan.acceptance)}`,
    `VERIFY\n  ${plan.verify ?? 'Check every ACCEPTANCE item yourself.'}`,
  ]
  // A read-only attempt runs in the user's own checkout: no worktree, so no reset and no setup patch.
  if (plan.readOnly) {
    sections.push('READ-ONLY\n  You run in the user\'s own checkout, not a worktree. Do not create, modify or delete any file, and run no git command that changes state. Your summary is the deliverable: put the full report in it.')
  } else {
    sections.push(`FORBIDDEN\n  Do not create, modify or delete files matching: ${plan.protected.join(', ') || '(none)'}\n  Do not commit. Do not stage files (no \`git add\`). Do not touch files outside this worktree.`)
    // The worktree is created from the remote default branch, not from the user's branch.
    const setup = [`git reset -q --hard ${args.baseCommit}`]
    if (args.setupPatch) {
      setup.push(`git apply --whitespace=nowarn "${args.setupPatch}"`)
      // Staged, so the verifier's plain `git diff` shows only the worker's own changes.
      setup.push('git add -A')
    }
    sections.push(`SETUP (do this first, in order)\n${setup.map((s) => `  ${s}`).join('\n')}\n  This moves the worktree to the user's current commit` +
      (args.setupPatch ? ' and applies their uncommitted changes; build on them.' : '.'))
  }
  if (history.length) {
    sections.push(`PREVIOUS ATTEMPTS (each started from a clean tree like yours; their code is gone)\n${bullets(history.map(summarize))}`)
    sections.push(`HINT\n  ${hint}`)
  }
  const skills = skillsSection(args.skills?.worker)
  if (skills) sections.push(skills)
  sections.push('REPORT\n  worktreePath: the output of `git rev-parse --show-toplevel` (not pwd).\n  status "blocked" only if the task cannot be done; say why in blockedReason. In summary, include concise handoff context: progress, decisions, user constraints supplied in TASK, cautions, failed approaches, and next steps. Separate verified work from unverified claims. Do not infer parent conversation context.')
  return sections.join('\n\n')
}

function verifyPrompt(plan, work) {
  const setup = args.setupFiles?.length
    ? `\nThese files hold the user's own uncommitted changes and are exempt from the protected check unless the worker changed them further: ${args.setupFiles.join(', ')}`
    : ''
  return `You verify one model-ladder attempt. Work only inside ${work.worktreePath}. Do not edit any file.

0. Run \`git -C "${work.worktreePath}" rev-parse HEAD\`. If it is not ${args.baseCommit}, fail with reason "wrong base".
1. ${args.setupPatch ? 'Confirm the setup patch is applied (the user\'s changes are present in the files it touches). If not, fail with reason "setup patch not applied". The user\'s starting changes are staged; the worker\'s changes are `git diff` (unstaged) plus untracked files, the `??` lines of step 2. Judge only those.' : 'Skip.'}
2. Run \`git -C "${work.worktreePath}" status --porcelain --untracked-files=all\`. If any changed or new file matches one of these globs, fail with reason "modified protected file <path>": ${plan.protected.join(', ') || '(none)'}${setup}
   Ignore build artifacts that running code rewrites: ${ARTIFACTS.join(', ')}
3. ${plan.verify ? `Run the verify step from the worktree root: ${plan.verify}\n   Pass only if it succeeds.` : 'There is no verify command. Judge each ACCEPTANCE item against the worker\'s changes (`git diff` plus new files). If the attempt changed no files, the task is read-only and the worker report below is the deliverable: judge it instead, and spot-check its claims against the sources it cites. Be strict: pass only if every item is clearly met.'}

ACCEPTANCE
${bullets(plan.acceptance)}

The worker claims: ${work.summary}
Do not trust the claim; check.${skillsSection(args.skills?.verifier) ? `\n\n${skillsSection(args.skills?.verifier)}` : ''}

Return output as the last ${OUTPUT_LINES} lines of what you ran.${args.usageGuard ? `

Final step, after everything above: run \`${args.usageGuard.command}\` and put its output unchanged in the usage field.` : ''}`
}

function diagnosePrompt(history, moves) {
  const latest = history[history.length - 1]
  const earlier = history.slice(0, -1)
  return `You are the router of model-ladder. An attempt failed. Decide what happens next.

TASK
${args.task}

${earlier.length ? `EARLIER ATTEMPTS\n${bullets(earlier.map(summarize))}\n\n` : ''}LATEST ATTEMPT (${label(latest.cell)})
Worker report: ${JSON.stringify(latest.work)}
Verdict: ${latest.verdict.reason}
Output:
${latest.verdict.output}

Choose one action:
- raise_effort: right direction, not deep enough (missed edge cases, sloppy logic). Pick a higher effort in the same model.
- raise_model: knowledge or capability gap (misuses an API, goes in circles, cannot follow the output format). Pick the next model; a low effort is fine if depth was not the problem.
- stop_environment: the failure is outside the code (missing dependency, broken test setup, unreachable service). A stronger model will not help.
- stop_unclear: the task is ambiguous and the worker had to guess.

For raise_*, model and effort must be one of these legal moves:
${bullets(moves.map(label))}
For stop_*, set model and effort to null.

hint: one or two sentences for the next worker naming what went wrong and where to look. It starts from a clean tree and cannot see this attempt's code.`
}

async function run(plan) {
  const { config } = args
  const history = []
  let cell = plan.start
  let hint = ''
  let tokens = plan.routeTokens ?? 0
  // Running a command needs no judgment; judging acceptance criteria does.
  const verifierCell = plan.verify ? config.verifier : config.router
  const workerType = plan.allowTests ? 'model-ladder:test-writer' : 'model-ladder:worker'

  const done = (status, winner, final) => ({
    status,
    plan: {
      goal: plan.goal, verify: plan.verify, start: label(plan.start), startReason: plan.startReason,
      allowTests: plan.allowTests, allowTestsReason: plan.allowTestsReason,
    },
    attempts: history.map((a) => ({
      cell: label(a.cell), pass: a.verdict.pass, reason: a.verdict.reason,
      action: a.diagnosis?.action ?? null, actionReason: a.diagnosis?.reason ?? null,
      tokens: a.tokens, worktreePath: a.work?.worktreePath ?? null,
      modelContext: a.work?.summary ? { source: `worker ${label(a.cell)}`, text: a.work.summary } : null,
      diagnosisContext: a.diagnosis ? { source: `diagnosis ${label(a.cell)}`, text: [a.diagnosis.reason, a.diagnosis.hint].filter(Boolean).join('\n') } : null,
    })),
    winner: winner ? { worktreePath: winner.worktreePath, filesChanged: winner.filesChanged, summary: winner.summary } : null,
    final,
    tokens,
  })

  for (let n = 1; n <= config.maxAttempts; n++) {
    phase(`Attempt ${n}`)
    const worker = await measured(brief(plan, history, hint), {
      label: `worker ${label(cell)}`, phase: `Attempt ${n}`, schema: WORKER_SCHEMA,
      agentType: workerType, ...(plan.readOnly ? {} : { isolation: 'worktree' }), ...cell,
    })
    tokens += worker.tokens
    const work = worker.result
    let verdict
    let verifyTokens = 0
    let limited = worker.limit && limitFinal(`worker ${label(cell)}`, worker.limit)
    if (!work) verdict = { pass: false, reason: `worker ${worker.error}`, output: '' }
    else if (work.status === 'blocked') verdict = { pass: false, reason: `worker blocked: ${work.blockedReason}`, output: '' }
    else if (plan.readOnly && work.filesChanged.length) verdict = { pass: false, reason: `read-only task changed ${work.filesChanged.join(', ')}`, output: '' }
    // Without a verify command an empty diff can be a read-only task; the verifier judges the report instead.
    else if (!work.filesChanged.length && plan.verify) verdict = { pass: false, reason: 'worker changed nothing', output: '' }
    else {
      const verifier = await measured(verifyPrompt(plan, work), {
        label: `verify ${label(verifierCell)}`, phase: `Attempt ${n}`, schema: verdictSchema(), agentType: 'model-ladder:verifier', ...verifierCell,
      })
      verifyTokens = verifier.tokens
      verdict = verifier.result ?? { pass: false, reason: `verifier ${verifier.error}`, output: '' }
      limited = verifier.limit && limitFinal(`verifier ${label(verifierCell)}`, verifier.limit)
    }
    tokens += verifyTokens
    const attempt = { cell, work, verdict, diagnosis: null, tokens: worker.tokens + verifyTokens }
    history.push(attempt)
    log(`#${n} ${label(cell)}: ${verdict.pass ? 'PASS' : `FAIL (${verdict.reason})`}`)

    if (verdict.pass) return done('VERIFIED', work, null)
    // Claude's own limit is spent: the next agent would die too. Stop now, keep this attempt's worktree.
    if (limited) return done('USAGE_LIMIT', null, limited)

    // Read live by the verifier: off means never stop, whatever the usage.
    const guard = args.usageGuard ? guardStop(verdict.usage) : null
    if (guard) {
      return done('USAGE_LIMIT', null, {
        reason: `Claude usage ${guard.usage}% reached the usageGuard threshold of ${guard.threshold}%.`,
        suggestion: LIMIT_SUGGESTION,
      })
    }

    const moves = legalMoves(cell, config.tiers)
    if (n === config.maxAttempts || !moves.length) break

    const diag = await measured(diagnosePrompt(history, moves), {
      label: `diagnose ${label(config.router)}`, phase: `Attempt ${n}`, schema: DIAGNOSIS_SCHEMA, agentType: 'model-ladder:router', ...config.router,
    })
    tokens += diag.tokens
    attempt.tokens += diag.tokens
    if (diag.limit) return done('USAGE_LIMIT', null, limitFinal('router (diagnosis)', diag.limit))
    const d = diag.result ?? { action: 'raise_effort', model: null, effort: null, reason: `router ${diag.error}; default move`, hint: '' }
    attempt.diagnosis = d
    if (d.action.startsWith('stop_')) return done('STOPPED', null, { reason: d.reason, suggestion: d.hint })
    const next = pickMove(d, cell, config.tiers)
    if (next.model !== d.model || next.effort !== d.effort) {
      log(`router chose ${d.model}/${d.effort}, not a legal move; using ${label(next)}`)
    }
    cell = next
    hint = d.hint
  }

  phase('Final diagnosis')
  const final = await measured(
    `model-ladder gave up on this task after ${history.length} attempts.

TASK
${args.task}

ATTEMPTS
${bullets(history.map(summarize))}

LAST OUTPUT
${history[history.length - 1].verdict.output}

Explain to the user why it failed (reason) and what they can do next (suggestion): clarify the task, fix the environment, raise the ladder's top, or do it by hand.`,
    { label: `final diagnosis ${label(args.config.router)}`, phase: 'Final diagnosis', schema: FINAL_SCHEMA, agentType: 'model-ladder:router', ...args.config.router },
  )
  tokens += final.tokens
  if (final.limit) return done('USAGE_LIMIT', null, limitFinal('router (final diagnosis)', final.limit))
  return done('FAILED', null, final.result)
}

async function workflow() {
if (!args?.task || !args?.config || !args?.protection) {
  throw new Error('model-ladder: this is the internal engine. Run /model-ladder:run <task> instead; it prepares these args and applies the result.')
}

// One call routes and runs. It returns early only when the user must answer first;
// the skill then calls again with `plan` (criteria filled in) or a clarified task.
const plan = args.plan ?? (await route())
// The router could not run: Claude's limit is spent. Nothing to keep; finish writes HANDOFF.md.
if (plan.limited) {
  return {
    status: 'USAGE_LIMIT',
    plan: { goal: args.task, verify: null, start: 'none', startReason: 'stopped before routing', allowTests: false, allowTestsReason: 'not routed' },
    attempts: [], winner: null, final: plan.limited, tokens: plan.routeTokens,
  }
}
// The caller does a small task itself when its own context makes orchestration the bigger cost.
if (!args.plan && plan.direct) {
  return { status: 'DIRECT', plan, attempts: [], tokens: plan.routeTokens }
}
// Questions and user acceptance gate execution; a forecast short on usage asks once, below.
if (!args.plan && plan.question) return { status: 'NEEDS_INPUT', plan }
if (!args.plan && plan.needsAcceptance) return { status: 'NEEDS_INPUT', plan }
// With a run lock (runId from preflight) the skill first claims plan.scope against other active runs
// (scripts/claim.mjs), then calls again with the plan.
if (!args.plan && args.runId) return { status: 'ROUTED', plan }
// The skill passes the forecast its boundary recorder returned after routing. Only an explicit yes continues,
// and only before the first worker: replayed continuations never ask again. usageGuard and limits still apply.
const risk = args.acceptUsageRisk === true || journal.some((e) => e.phase === 'worker') ? null : usageRisk(args.forecast?.current)
if (risk) return { status: 'NEEDS_INPUT', reason: 'USAGE_RISK', plan, usageRisk: risk }
return await run(plan)
}

try {
  const result = await workflow()
  return args?.telemetry ? { ...result, journal } : result
} catch (error) {
  if (args?.telemetry && error?.boundary) return { status: 'BOUNDARY', journal }
  if (args?.telemetry) return { status: 'ERROR', journal, error: String(error?.message ?? error) }
  throw error
}
