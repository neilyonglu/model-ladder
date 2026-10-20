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

// Orchestration re-reads the caller's context on every turn; past this size a small task costs
// less done directly. Provisional: see DESIGN.md › Ladder or direct.
const LARGE_CONTEXT = 150000

function isDirect(small, contextTokens, forceLadder) {
  return !forceLadder && small && (contextTokens ?? 0) > LARGE_CONTEXT
}

function isCell(choice, tiers) {
  return tiers.some((tier) => tier.model === choice?.model && tier.efforts.includes(choice?.effort))
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
    smallReason: { type: 'string' },
  },
  required: ['model', 'effort', 'reason', 'goal', 'scope', 'verify', 'acceptance', 'allowTests', 'allowTestsReason', 'question', 'small', 'smallReason'],
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
// output. Either way this step failed; the ladder decides what happens next.
async function measured(prompt, opts) {
  const before = budget.spent()
  try {
    const result = await agent(prompt, opts)
    return { result, error: result ? null : 'died before reporting', tokens: budget.spent() - before }
  } catch (e) {
    return { result: null, error: `failed: ${String(e?.message ?? e).slice(0, 200)}`, tokens: budget.spent() - before }
  }
}

async function route() {
  const { task, config } = args
  const verifyKnown = config.verify ? `The project sets the verify command: ${config.verify}` :
    args.hasVerifySkill ? 'The project has a verify skill; set verify to null, it will be used.' :
    'Find the verify command the repo already has (a test suite in pyproject.toml, package.json, Makefile, pom.xml, ...). It must run checks that exist before this task. Never write a new check yourself, not even a one-line assert: that would let you, not the user, define done. Use null if the repo has no tests that cover this task.'
  const prompt = `You are the router of model-ladder. Read the task and the repo (read-only), then pick where the work starts.

TASK
${task}

GRID (each tier is stronger than the one above it; effort raises depth within a tier)
${grid(config.tiers)}

Pick the cheapest cell likely to succeed in one attempt. A failed attempt escalates, so do not start high to be safe; start high only for work that clearly needs it (architecture, hard cross-cutting bugs).

Also return:
- goal: the task as one sentence a stranger could execute.
- scope: files you expect to change.
- verify: ${verifyKnown}
- acceptance: checkable done criteria, one per item. ${args.acceptance?.length ? 'The user already gave them; return them unchanged.' : 'Empty if the verify command alone defines done.'}
- allowTests: true only when the task itself is to write or change tests. A bug fix is not: the tests define the expected behavior.
- question: if the task is too vague to act on (no clear outcome, several very different readings), the one question that would settle it. Otherwise null. A worker would guess, and passing tests would hide the guess.
- small: true when the task touches one or two files and its design is already given (for example "implement this function as described"), so a capable model would finish it in one pass. Otherwise false.
- smallReason: one sentence on why.`
  const { result: r, error, tokens } = await measured(prompt, {
    label: 'route', phase: 'Route', schema: ROUTE_SCHEMA, agentType: 'model-ladder:router', ...config.router,
  })
  if (!r) throw new Error(`model-ladder: the router ${error}`)
  const lowest = { model: config.tiers[0].model, effort: config.tiers[0].efforts[0] }
  const start = isCell(r, config.tiers) ? { model: r.model, effort: r.effort } : lowest
  const verify = config.verify ?? (args.hasVerifySkill ? VERIFY_SKILL : r.verify)
  const acceptance = args.acceptance?.length ? args.acceptance : r.acceptance
  return {
    start,
    startReason: isCell(r, config.tiers) ? r.reason : `Router picked ${label(r)}, not in the grid; starting at ${label(lowest)}`,
    goal: r.goal,
    scope: r.scope,
    verify,
    acceptance: acceptance.length || !verify ? acceptance : ['The verify command passes'],
    allowTests: r.allowTests,
    allowTestsReason: r.allowTestsReason,
    protected: protectedPatterns(args.protection, r.allowTests),
    question: r.question,
    direct: isDirect(r.small === true, args.contextTokens, args.forceLadder),
    directReason: `${r.smallReason} The calling session holds about ${args.contextTokens} tokens of context, ${(args.contextTokens ?? 0) > LARGE_CONTEXT ? 'above' : 'not above'} the ${LARGE_CONTEXT} threshold.`,
    // Without a verify step the user, not the router, decides what done means.
    needsAcceptance: !verify && !args.acceptance?.length,
    routeTokens: tokens,
  }
}

function summarize(attempt, i) {
  return `#${i + 1} ${label(attempt.cell)}: ${attempt.verdict.reason}` +
    (attempt.diagnosis ? ` -> ${attempt.diagnosis.action}: ${attempt.diagnosis.reason}` : '')
}

function brief(plan, history, hint) {
  const sections = [
    `GOAL\n  ${plan.goal}`,
    `TASK (as the user wrote it)\n  ${args.task}`,
    `SCOPE\n  ${plan.scope.length ? plan.scope.join(', ') : 'Decide from the code.'}`,
    `ACCEPTANCE\n${bullets(plan.acceptance)}`,
    `VERIFY\n  ${plan.verify ?? 'Check every ACCEPTANCE item yourself.'}`,
    `FORBIDDEN\n  Do not create, modify or delete files matching: ${plan.protected.join(', ') || '(none)'}\n  Do not commit. Do not touch files outside this worktree.`,
  ]
  // The worktree is created from the remote default branch, not from the user's branch.
  const setup = [`git reset -q --hard ${args.baseCommit}`]
  if (args.setupPatch) setup.push(`git apply --whitespace=nowarn "${args.setupPatch}"`)
  sections.push(`SETUP (do this first, in order)\n${setup.map((s) => `  ${s}`).join('\n')}\n  This moves the worktree to the user's current commit` +
    (args.setupPatch ? ' and applies their uncommitted changes; build on them.' : '.'))
  if (history.length) {
    sections.push(`PREVIOUS ATTEMPTS (each started from a clean tree like yours; their code is gone)\n${bullets(history.map(summarize))}`)
    sections.push(`HINT\n  ${hint}`)
  }
  sections.push('REPORT\n  worktreePath: the output of `git rev-parse --show-toplevel` (not pwd).\n  status "blocked" only if the task cannot be done; say why in blockedReason.')
  return sections.join('\n\n')
}

function verifyPrompt(plan, work) {
  const setup = args.setupFiles?.length
    ? `\nThese files hold the user's own uncommitted changes and are exempt from the protected check unless the worker changed them further: ${args.setupFiles.join(', ')}`
    : ''
  return `You verify one model-ladder attempt. Work only inside ${work.worktreePath}. Do not edit any file.

0. Run \`git -C "${work.worktreePath}" rev-parse HEAD\`. If it is not ${args.baseCommit}, fail with reason "wrong base".
1. ${args.setupPatch ? 'Confirm the setup patch is applied (the user\'s changes are present in the files it touches). If not, fail with reason "setup patch not applied".' : 'Skip.'}
2. Run \`git -C "${work.worktreePath}" status --porcelain --untracked-files=all\`. If any changed or new file matches one of these globs, fail with reason "modified protected file <path>": ${plan.protected.join(', ') || '(none)'}${setup}
   Ignore build artifacts that running code rewrites: ${ARTIFACTS.join(', ')}
3. ${plan.verify ? `Run the verify step from the worktree root: ${plan.verify}\n   Pass only if it succeeds.` : 'There is no verify command. Judge each ACCEPTANCE item against the diff (`git diff` plus new files). If the attempt changed no files, the task is read-only and the worker report below is the deliverable: judge it instead, and spot-check its claims against the sources it cites. Be strict: pass only if every item is clearly met.'}

ACCEPTANCE
${bullets(plan.acceptance)}

The worker claims: ${work.summary}
Do not trust the claim; check.

Return output as the last ${OUTPUT_LINES} lines of what you ran.`
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
    })),
    winner: winner ? { worktreePath: winner.worktreePath, filesChanged: winner.filesChanged, summary: winner.summary } : null,
    final,
    tokens,
  })

  for (let n = 1; n <= config.maxAttempts; n++) {
    phase(`Attempt ${n}`)
    const worker = await measured(brief(plan, history, hint), {
      label: `worker ${label(cell)}`, phase: `Attempt ${n}`, schema: WORKER_SCHEMA,
      agentType: workerType, isolation: 'worktree', ...cell,
    })
    tokens += worker.tokens
    const work = worker.result
    let verdict
    let verifyTokens = 0
    if (!work) verdict = { pass: false, reason: `worker ${worker.error}`, output: '' }
    else if (work.status === 'blocked') verdict = { pass: false, reason: `worker blocked: ${work.blockedReason}`, output: '' }
    // Without a verify command an empty diff can be a read-only task; the verifier judges the report instead.
    else if (!work.filesChanged.length && plan.verify) verdict = { pass: false, reason: 'worker changed nothing', output: '' }
    else {
      const verifier = await measured(verifyPrompt(plan, work), {
        label: 'verify', phase: `Attempt ${n}`, schema: VERDICT_SCHEMA, agentType: 'model-ladder:verifier', ...verifierCell,
      })
      verifyTokens = verifier.tokens
      verdict = verifier.result ?? { pass: false, reason: `verifier ${verifier.error}`, output: '' }
    }
    tokens += verifyTokens
    const attempt = { cell, work, verdict, diagnosis: null, tokens: worker.tokens + verifyTokens }
    history.push(attempt)
    log(`#${n} ${label(cell)}: ${verdict.pass ? 'PASS' : `FAIL (${verdict.reason})`}`)

    if (verdict.pass) return done('VERIFIED', work, null)

    const moves = legalMoves(cell, config.tiers)
    if (n === config.maxAttempts || !moves.length) break

    const diag = await measured(diagnosePrompt(history, moves), {
      label: 'diagnose', phase: `Attempt ${n}`, schema: DIAGNOSIS_SCHEMA, agentType: 'model-ladder:router', ...config.router,
    })
    tokens += diag.tokens
    attempt.tokens += diag.tokens
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
    { label: 'final diagnosis', phase: 'Final diagnosis', schema: FINAL_SCHEMA, agentType: 'model-ladder:router', ...args.config.router },
  )
  tokens += final.tokens
  return done('FAILED', null, final.result)
}

if (!args?.task || !args?.config || !args?.protection) {
  throw new Error('model-ladder: this is the internal engine. Run /model-ladder:run <task> instead; it prepares these args and applies the result.')
}

// One call routes and runs. It returns early only when the user must answer first;
// the skill then calls again with `plan` (criteria filled in) or a clarified task.
const plan = args.plan ?? (await route())
// The caller does a small task itself when its own context makes orchestration the bigger cost.
if (!args.plan && plan.direct) {
  return { status: 'DIRECT', plan: { goal: plan.goal, directReason: plan.directReason }, attempts: [], tokens: plan.routeTokens }
}
if (!args.plan && (plan.question || plan.needsAcceptance)) return { status: 'NEEDS_INPUT', plan }
return await run(plan)
