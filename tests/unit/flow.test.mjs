import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../../workflows/ladder.js', import.meta.url), 'utf8').replace(/^export /m, '')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const body = new AsyncFunction('args', 'agent', 'budget', 'phase', 'log', src)

const config = {
  router: { model: 'sonnet', effort: 'low' },
  verifier: { model: 'haiku', effort: 'low' },
  tiers: [
    { model: 'haiku', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
    { model: 'sonnet', efforts: ['low', 'medium', 'high'], maxEffortJump: 2 },
    { model: 'opus', efforts: ['low', 'medium', 'high', 'xhigh'], maxEffortJump: 1 },
  ],
  maxAttempts: 4,
  verify: null,
}
const protection = { always: ['.claude/model-ladder.json'], tests: ['**/tests/**'] }

// Each scripted step answers one agent() call whose label starts with step.label.
// A step with `throws` makes agent() throw, as it does for invalid structured output.
function harness(steps) {
  const calls = []
  let spent = 0
  const agent = async (prompt, opts) => {
    const step = steps.shift()
    assert.ok(step, `unexpected agent call: ${opts.label}`)
    assert.ok(opts.label.startsWith(step.label), `expected ${step.label}, got ${opts.label}`)
    calls.push({ label: opts.label, schema: opts.schema, model: opts.model, effort: opts.effort, isolation: opts.isolation, agentType: opts.agentType, prompt })
    spent += 10
    if (step.throws) throw new Error(step.throws)
    return step.result
  }
  const budget = { total: null, spent: () => spent, remaining: () => Infinity }
  return { agent, budget, calls, rest: steps }
}

async function call(steps, extra = {}) {
  const h = harness(steps)
  const out = await body({ task: 't', config, protection, ...extra }, h.agent, h.budget, () => {}, () => {})
  assert.deepEqual(h.rest, [], 'unused scripted steps')
  return { out, calls: h.calls }
}

const plan = {
  start: { model: 'haiku', effort: 'low' }, startReason: 'small', goal: 'Fix it', scope: [], verify: 'uv run pytest',
  acceptance: ['The verify command passes'], protected: ['**/tests/**'], allowTests: false, allowTestsReason: 'bug fix',
}
const runWith = (steps, extra = {}) => call(steps, { plan, ...extra })
const done = { status: 'done', worktreePath: '/wt', filesChanged: ['a.py'], summary: 's', selfCheck: '', blockedReason: null }
const pass = { pass: true, reason: 'ok', output: '' }
const fail = { pass: false, reason: 'tests fail', output: 'E assert' }
const diag = (action, model, effort) => ({ action, model, effort, reason: 'r', hint: 'h' })

test('passes on the first attempt', async () => {
  const { out, calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }])
  assert.equal(out.status, 'VERIFIED')
  assert.deepEqual(out.winner, { worktreePath: '/wt', filesChanged: ['a.py'], summary: 's' })
  assert.equal(out.attempts.length, 1)
  assert.equal(calls[0].model, 'haiku')
  assert.equal(calls[0].isolation, 'worktree')
  assert.equal(calls[0].agentType, 'model-ladder:worker')
  assert.equal(out.tokens, 20)
})

test('a verify command is checked by the cheap verifier; acceptance-only by the router model', async () => {
  const withCommand = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }])
  assert.equal(withCommand.calls[1].model, 'haiku')
  const withoutCommand = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], { plan: { ...plan, verify: null } })
  assert.equal(withoutCommand.calls[1].model, 'sonnet')
})

test('a test-writing task runs on the test-writer agent', async () => {
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], { plan: { ...plan, allowTests: true } })
  assert.equal(calls[0].agentType, 'model-ladder:test-writer')
})

test('follows a legal router choice and carries the hint forward', async () => {
  const { out, calls } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'diagnose', result: diag('raise_model', 'sonnet', 'medium') },
    { label: 'worker', result: done }, { label: 'verify', result: pass },
  ])
  assert.equal(out.status, 'VERIFIED')
  assert.equal(calls[3].model, 'sonnet')
  assert.equal(calls[3].effort, 'medium')
  assert.match(calls[3].prompt, /HINT\n {2}h/)
  assert.match(calls[3].prompt, /#1 haiku\/low: tests fail -> raise_model/)
  assert.deepEqual(out.attempts.map((a) => a.action), ['raise_model', null])
})

test('an illegal router choice falls back to the default move', async () => {
  const { calls } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'diagnose', result: diag('raise_model', 'opus', 'xhigh') },
    { label: 'worker', result: done }, { label: 'verify', result: pass },
  ])
  assert.equal(`${calls[3].model}/${calls[3].effort}`, 'haiku/medium')
})

test('stop_environment stops without escalating', async () => {
  const { out } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'diagnose', result: diag('stop_environment', null, null) },
  ])
  assert.equal(out.status, 'STOPPED')
  assert.equal(out.attempts.length, 1)
})

test('blocked, empty, dead and throwing workers fail without calling the verifier', async () => {
  const { out } = await runWith([
    { label: 'worker', result: { ...done, status: 'blocked', blockedReason: 'nope' } },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
    { label: 'worker', result: { ...done, filesChanged: [] } },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'high') },
    { label: 'worker', result: null },
    { label: 'diagnose', result: diag('raise_model', 'sonnet', 'low') },
    { label: 'worker', throws: 'StructuredOutput invalid after 5 retries' },
    { label: 'final diagnosis', result: { reason: 'r', suggestion: 's' } },
  ])
  assert.equal(out.status, 'FAILED')
  assert.deepEqual(out.attempts.map((a) => a.reason), [
    'worker blocked: nope', 'worker changed nothing', 'worker died before reporting',
    'worker failed: StructuredOutput invalid after 5 retries',
  ])
})

test('without a verify command an empty diff is a read-only report the verifier judges', async () => {
  const { out, calls } = await runWith(
    [{ label: 'worker', result: { ...done, filesChanged: [], summary: 'the report' } }, { label: 'verify', result: pass }],
    { plan: { ...plan, verify: null } },
  )
  assert.equal(out.status, 'VERIFIED')
  assert.equal(out.winner.summary, 'the report')
  assert.match(calls[1].prompt, /read-only/)
})

test('a read-only plan runs the worker in the user checkout, without a worktree or reset', async () => {
  const ro = { ...plan, verify: null, readOnly: true }
  const { out, calls } = await runWith(
    [{ label: 'worker', result: { ...done, filesChanged: [], summary: 'the report' } }, { label: 'verify', result: pass }],
    { plan: ro, baseCommit: 'abc' },
  )
  assert.equal(out.status, 'VERIFIED')
  assert.equal(calls[0].isolation, undefined)
  assert.match(calls[0].prompt, /READ-ONLY/)
  assert.doesNotMatch(calls[0].prompt, /reset/)
  const edited = await runWith(
    [{ label: 'worker', result: done }, { label: 'final diagnosis', result: { reason: 'r', suggestion: 's' } }],
    { plan: { ...ro, start: { model: 'opus', effort: 'xhigh' } } },
  )
  assert.equal(edited.out.attempts[0].reason, 'read-only task changed a.py')
})

test('directReason says whether the context is above the threshold', async () => {
  const route = { model: 'haiku', effort: 'low', reason: 'r', goal: 'g', scope: [], verify: null, acceptance: ['a'], allowTests: false, allowTestsReason: 'r', question: null, small: false, smallReason: 'Not small.' }
  const { out } = await call([{ label: 'route', result: route }], { contextTokens: 45000 })
  assert.match(out.plan.directReason, /45000 tokens of context, 23% of a 200000-token window; the DIRECT threshold is 30%/)
})

test('a throwing diagnosis falls back to the default move', async () => {
  const { calls } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'diagnose', throws: 'boom' },
    { label: 'worker', result: done }, { label: 'verify', result: pass },
  ])
  assert.equal(`${calls[3].model}/${calls[3].effort}`, 'haiku/medium')
})

test('gives up after maxAttempts with a final diagnosis', async () => {
  const { out } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail }, { label: 'diagnose', result: diag('raise_effort', 'haiku', 'high') },
    { label: 'worker', result: done }, { label: 'verify', result: fail }, { label: 'diagnose', result: diag('raise_model', 'sonnet', 'high') },
    { label: 'worker', result: done }, { label: 'verify', result: fail }, { label: 'diagnose', result: diag('raise_model', 'opus', 'low') },
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'final diagnosis', result: { reason: 'r', suggestion: 's' } },
  ])
  assert.equal(out.status, 'FAILED')
  assert.deepEqual(out.attempts.map((a) => a.cell), ['haiku/low', 'haiku/high', 'sonnet/high', 'opus/low'])
  assert.deepEqual(out.final, { reason: 'r', suggestion: 's' })
})

test('the top cell gives up without a diagnose call', async () => {
  const { out } = await runWith(
    [{ label: 'worker', result: done }, { label: 'verify', result: fail }, { label: 'final diagnosis', result: { reason: 'r', suggestion: 's' } }],
    { plan: { ...plan, start: { model: 'opus', effort: 'xhigh' } } },
  )
  assert.equal(out.status, 'FAILED')
})

const routed = {
  model: 'sonnet', effort: 'medium', reason: 'r', goal: 'g', scope: [], verify: 'uv run pytest',
  acceptance: [], allowTests: false, allowTestsReason: 'bug fix', question: null, small: false, smallReason: '',
}
const routeThenPass = (r, extra) => call([
  { label: 'route', result: r }, { label: 'worker', result: done }, { label: 'verify', result: pass },
], extra)
const routeOnly = (r, extra) => call([{ label: 'route', result: r }], extra)

test('one call routes and runs', async () => {
  const { out, calls } = await routeThenPass(routed)
  assert.equal(out.status, 'VERIFIED')
  assert.equal(out.plan.start, 'sonnet/medium')
  assert.equal(`${calls[1].model}/${calls[1].effort}`, 'sonnet/medium')
  assert.match(calls[1].prompt, /\*\*\/tests\/\*\*/)
  assert.equal(out.tokens, 30)
})

test('route falls back to the lowest cell for an off-grid pick', async () => {
  const { calls } = await routeThenPass({ ...routed, model: 'haiku', effort: 'xhigh' })
  assert.equal(`${calls[1].model}/${calls[1].effort}`, 'haiku/low')
})

test('verify precedence: config, then verify skill, then router', async () => {
  assert.equal((await routeThenPass(routed, { config: { ...config, verify: 'make check' } })).out.plan.verify, 'make check')
  assert.match((await routeThenPass(routed, { hasVerifySkill: true })).out.plan.verify, /verify skill/)
  assert.equal((await routeThenPass(routed)).out.plan.verify, 'uv run pytest')
})

test('allowed tests drop the test patterns but keep the always-protected ones', async () => {
  const { calls } = await call([
    { label: 'route', result: { ...routed, allowTests: true } }, { label: 'worker', result: done }, { label: 'verify', result: pass },
  ])
  assert.doesNotMatch(calls[1].prompt, /\*\*\/tests\/\*\*/)
  assert.match(calls[1].prompt, /\.claude\/model-ladder\.json/)
})

test('no verify returns for user input, with the router proposal', async () => {
  const { out } = await routeOnly({ ...routed, verify: null, acceptance: ['prints NT$ 1,234'] })
  assert.equal(out.status, 'NEEDS_INPUT')
  assert.equal(out.plan.needsAcceptance, true)
  assert.deepEqual(out.plan.acceptance, ['prints NT$ 1,234'])
  assert.match(out.plan.acceptanceMessage, /\*\*Acceptance criteria \(proposed\)\*\*\n1\. prints NT\$ 1,234\n\nTip: run \/model-ladder:create-verification-skill to generate \.claude\/skills\/verify\/;/)
  assert.equal(out.plan.acceptanceQuestion, 'Run with these criteria?')
})

test('with a run lock, it returns after routing so the skill can claim the scope, then runs the plan', async () => {
  const { out } = await routeOnly({ ...routed, scope: ['shop/cart.py'] }, { runId: 'claude-1' })
  assert.equal(out.status, 'ROUTED')
  assert.deepEqual(out.plan.scope, ['shop/cart.py'])
  assert.equal(out.plan.readOnly, false)
  const second = await call([{ label: 'worker', result: done }, { label: 'verify', result: pass }], { runId: 'claude-1', plan: out.plan })
  assert.equal(second.out.status, 'VERIFIED')
})

test('a vague task returns the router question', async () => {
  const { out } = await routeOnly({ ...routed, question: 'Better how?' })
  assert.equal(out.status, 'NEEDS_INPUT')
  assert.equal(out.plan.question, 'Better how?')
})

test('called directly without the skill, it points to /model-ladder:run', async () => {
  const h = harness([])
  await assert.rejects(body(undefined, h.agent, h.budget, () => {}, () => {}), /Run \/model-ladder:run <task> instead/)
  await assert.rejects(body({ task: 't' }, h.agent, h.budget, () => {}, () => {}), /internal engine/)
})

test('a small task in a large session comes back DIRECT, before any worker', async () => {
  const { out } = await routeOnly({ ...routed, small: true, smallReason: 'one function' }, { contextTokens: 400000 })
  assert.equal(out.status, 'DIRECT')
  assert.match(out.plan.directReason, /one function/)
  assert.match(out.plan.directReason, /400000/)
  assert.deepEqual(out.attempts, [])
})

test('a small task in a small session, or a large task anywhere, still runs the ladder', async () => {
  assert.equal((await routeThenPass({ ...routed, small: true }, { contextTokens: 50000 })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...routed, small: false }, { contextTokens: 400000 })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...routed, small: true })).out.status, 'VERIFIED')
})

test('DIRECT is a percentage of the context window: boundary, off, missing window', async () => {
  const run = async (extra) => ((await routeOnly({ ...routed, small: true }, extra)).out.status === 'DIRECT' ? 'DIRECT' : 'VERIFIED')
  assert.equal(await run({ contextTokens: 60000, contextWindow: 200000 }), 'DIRECT')
  assert.equal(await run({ contextTokens: 59999, contextWindow: 200000 }), 'VERIFIED')
  assert.equal(await run({ contextTokens: 300000, contextWindow: 1000000, directThreshold: 30 }), 'DIRECT')
  assert.equal(await run({ contextTokens: 299999, contextWindow: 1000000, directThreshold: 30 }), 'VERIFIED')
  assert.equal(await run({ contextTokens: 100000, contextWindow: 200000, directThreshold: 60 }), 'VERIFIED')
  assert.equal(await run({ contextTokens: 120000, contextWindow: 200000, directThreshold: 60 }), 'DIRECT')
  assert.equal(await run({ contextTokens: 900000, contextWindow: 1000000, directThreshold: 'off' }), 'VERIFIED')
  assert.equal(await run({ contextTokens: 60000 }), 'DIRECT')
  assert.equal(await run({ contextTokens: 59000 }), 'VERIFIED')
  assert.equal((await routeOnly({ ...routed, small: false }, { contextTokens: 190000, contextWindow: 200000 })).out.status === 'DIRECT' ? 'DIRECT' : 'VERIFIED', 'VERIFIED')
})

test('forceLadder overrides DIRECT', async () => {
  const { out } = await routeThenPass({ ...routed, small: true }, { contextTokens: 400000, forceLadder: true })
  assert.equal(out.status, 'VERIFIED')
})

const parts = [{ task: 'part one', scope: ['a.py'] }, { task: 'part two', scope: ['b.py'] }]
const long = { ...routed, estimatedMinutes: 35, split: parts }
// The workflow's first-call result; a run that went on to a worker would fail on the unscripted agent call.
const splitStatus = async (r, extra) => (await routeOnly(r, extra)).out

test('the router prompt and schema ask for estimatedMinutes and split', async () => {
  const { calls } = await routeOnly(long, { splitMinutes: 30 })
  assert.equal(calls[0].schema.properties.estimatedMinutes.type, 'integer')
  assert.equal(calls[0].schema.properties.split.type, 'array')
  assert.deepEqual(calls[0].schema.properties.split.items.required, ['task', 'scope'])
  assert.ok(calls[0].schema.required.includes('estimatedMinutes') && calls[0].schema.required.includes('split'))
  assert.match(calls[0].prompt, /estimatedMinutes: integer.*including the time the tests take/)
  assert.match(calls[0].prompt, /more than 30, the task cut into subtasks/)
  assert.match((await routeOnly(long, { splitMinutes: 'off' })).calls[0].prompt, /split: always an empty array/)
  assert.match((await routeOnly(long)).calls[0].prompt, /more than 20, the task cut into subtasks/)
})

test('an estimate over the limit with a split comes back NEEDS_INPUT with the suggestion', async () => {
  const out = await splitStatus(long, { splitMinutes: 30 })
  assert.equal(out.status, 'NEEDS_INPUT')
  assert.deepEqual(out.plan.splitSuggestion, { estimatedMinutes: 35, limit: 30, parts })
  assert.equal((await splitStatus(long)).plan.splitSuggestion.limit, 20)
})

test('an estimate equal to the limit, or under it, does not split', async () => {
  assert.equal((await routeThenPass({ ...long, estimatedMinutes: 30 }, { splitMinutes: 30 })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...long, estimatedMinutes: 20 })).out.status, 'VERIFIED')
  assert.equal((await splitStatus({ ...long, estimatedMinutes: 31 }, { splitMinutes: 30 })).status, 'NEEDS_INPUT')
})

test('off, an empty split, forceLadder and acceptSplit:false skip the split suggestion', async () => {
  assert.equal((await routeThenPass(long, { splitMinutes: 'off' })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...long, split: [] })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...long, split: undefined })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass(long, { forceLadder: true })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass(long, { acceptSplit: false })).out.status, 'VERIFIED')
  assert.equal((await routeThenPass({ ...routed, split: parts })).out.status, 'VERIFIED')
})

test('a DIRECT task is never offered a split', async () => {
  const { out } = await routeOnly({ ...long, small: true, smallReason: 'one function' }, { contextTokens: 400000 })
  assert.equal(out.status, 'DIRECT')
})

test('a question is asked before the split; the split before acceptance criteria', async () => {
  const asked = await splitStatus({ ...long, question: 'Better how?' })
  assert.equal(asked.plan.question, 'Better how?')
  assert.equal(asked.plan.splitSuggestion.limit, 20)
  const noVerify = await splitStatus({ ...long, verify: null })
  assert.equal(noVerify.plan.needsAcceptance, true)
  assert.ok(noVerify.plan.splitSuggestion)
  const whole = await splitStatus({ ...long, verify: null }, { acceptSplit: false })
  assert.equal(whole.plan.needsAcceptance, true)
  assert.equal(whole.plan.splitSuggestion, null)
})

test('a router that fails to report stops the run', async () => {
  await assert.rejects(call([{ label: 'route', throws: 'boom' }]), /the router failed: boom/)
})

const usageGuard = { command: 'node "/p/usage-guard.mjs" --root "/repo"' }
// What scripts/usage-guard.mjs prints at the moment the verifier runs it.
const live = (enabled, usage, threshold = 90) => JSON.stringify({ enabled, threshold, usage })

test('without a usage command the verifier prompt and schema are unchanged', async () => {
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }])
  assert.doesNotMatch(calls[1].prompt, /usage/)
  assert.deepEqual(calls[1].schema.required, ['pass', 'reason', 'output'])
  assert.equal('usage' in calls[1].schema.properties, false)
})

test('the verifier runs the usage command last and must report its output', async () => {
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage: live(true, 10) } }], { usageGuard })
  assert.ok(calls[1].prompt.trimEnd().endsWith(`run \`${usageGuard.command}\` and put its output unchanged in the usage field.`))
  assert.deepEqual(calls[1].schema.required, ['pass', 'reason', 'output', 'usage'])
  assert.deepEqual(calls[1].schema.properties.usage, { type: 'string' })
})

test('guard on: a failed attempt at the threshold stops with USAGE_LIMIT, no diagnosis', async () => {
  const { out } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(true, 92.5) } }], { usageGuard })
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.equal(out.winner, null)
  assert.equal(out.final.reason, 'Claude usage 92.5% reached the usageGuard threshold of 90%.')
  assert.match(out.final.suggestion, /HANDOFF\.md/)
  assert.deepEqual(out.attempts.map((a) => [a.pass, a.worktreePath]), [[false, '/wt']])
})

test('guard on: below the threshold, unknown or unreadable usage keeps escalating', async () => {
  for (const usage of [live(true, 89), live(true, null), 'unknown', '', '{"enabled":true', '93']) {
    const { out } = await runWith([
      { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage } },
      { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
      { label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage } },
    ], { usageGuard })
    assert.equal(out.status, 'VERIFIED', usage)
  }
})

test('guard on: a passing attempt is VERIFIED even above the threshold', async () => {
  const { out } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage: live(true, 99) } }], { usageGuard })
  assert.equal(out.status, 'VERIFIED')
})

test('guard turned off mid-run: high usage never stops the run', async () => {
  const { out } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(false, 99) } },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(false, 100) } },
    { label: 'diagnose', result: diag('raise_model', 'sonnet', 'low') },
    { label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage: live(false, 100) } },
  ], { usageGuard })
  assert.equal(out.status, 'VERIFIED')
  assert.equal(out.attempts.length, 3)
})

test('guard turned on mid-run: the next check stops the run', async () => {
  const { out } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(false, 95) } },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(true, 95) } },
  ], { usageGuard })
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.equal(out.attempts.length, 2)
})

test('threshold changed mid-run: the next check uses the new threshold', async () => {
  const { out } = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(true, 95, 99) } },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
    { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: live(true, 95, 80) } },
  ], { usageGuard })
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.equal(out.final.reason, 'Claude usage 95% reached the usageGuard threshold of 80%.')
})

const SESSION_LIMIT = "You've hit your session limit · resets 3pm (Asia/Taipei)"

test('hard limit: a worker that hits Claude\'s limit stops the run at once, guard off', async () => {
  const { out, calls } = await runWith([{ label: 'worker', throws: SESSION_LIMIT }])
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.equal(calls.length, 1, 'no verifier, diagnosis or next worker')
  assert.ok(out.final.reason.includes(SESSION_LIMIT), out.final.reason)
  assert.match(out.final.reason, /resets 3pm \(Asia\/Taipei\)/)
  assert.match(out.final.suggestion, /HANDOFF\.md/)
  assert.equal(out.winner, null)
  assert.deepEqual(out.attempts.map((a) => a.pass), [false])
})

test('hard limit: a verifier that hits it keeps the attempt worktree for the handoff', async () => {
  const { out } = await runWith([{ label: 'worker', result: done }, { label: 'verify', throws: 'API Error: 429 Too Many Requests' }])
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.match(out.final.reason, /verifier .*429 Too Many Requests/)
  assert.deepEqual(out.attempts.map((a) => a.worktreePath), ['/wt'])
})

test('hard limit after earlier attempts: diagnosis or final diagnosis that hits it is USAGE_LIMIT, not FAILED', async () => {
  const atDiagnosis = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'diagnose', throws: 'Claude usage limit reached. Your limit resets at 5pm.' },
  ])
  assert.equal(atDiagnosis.out.status, 'USAGE_LIMIT')
  assert.match(atDiagnosis.out.final.reason, /resets 5pm/)
  assert.deepEqual(atDiagnosis.out.attempts.map((a) => a.worktreePath), ['/wt'])
  const atFinal = await runWith([
    { label: 'worker', result: done }, { label: 'verify', result: fail },
    { label: 'final diagnosis', throws: 'rate_limit_error: you have exceeded your rate limit' },
  ], { config: { ...config, maxAttempts: 1 } })
  assert.equal(atFinal.out.status, 'USAGE_LIMIT')
  assert.match(atFinal.out.final.reason, /rate_limit_error/)
})

test('hard limit at routing: USAGE_LIMIT with no attempts instead of a crash', async () => {
  const { out } = await call([{ label: 'route', throws: SESSION_LIMIT }])
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.deepEqual(out.attempts, [])
  assert.ok(out.final.reason.includes(SESSION_LIMIT))
  assert.equal(out.plan.start, 'none')
})

test('an ordinary agent failure is not a hard limit and still escalates', async () => {
  const { out } = await runWith([
    { label: 'worker', throws: 'structured output invalid' },
    { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
    { label: 'worker', result: done }, { label: 'verify', result: pass },
  ])
  assert.equal(out.status, 'VERIFIED')
})

test('hardLimit recognizes subscription limit messages and their reset time', () => {
  const pure = src.split('// <pure>')[1].split('// </pure>')[0]
  const { hardLimit } = new Function(`${pure}; return { hardLimit }`)()
  assert.deepEqual(hardLimit(SESSION_LIMIT), { message: SESSION_LIMIT, resets: '3pm (Asia/Taipei)' })
  assert.equal(hardLimit("You've hit your weekly limit").resets, null)
  for (const text of ['Claude AI usage limit reached|1761800000', 'Error 429', 'rate limit exceeded', 'Too Many Requests']) assert.ok(hardLimit(text), text)
  for (const text of ['structured output invalid', 'died before reporting', '', undefined]) assert.equal(hardLimit(text), null, String(text))
})

test('skill instructions stay intact, stay in their role, and omit empty or unresolved values', async () => {
  const worker = 'When coding, use ponytail:ponytail.\nWhen doing UI, use available UI/UX skills.'
  const verifier = 'When reviewing code, use ponytail:ponytail.\nReport findings without fixing code.'
  const skills = { worker, verifier }
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], { skills })
  assert.ok(calls[0].prompt.includes(`SKILL INSTRUCTIONS\n${worker}\n\nInterpret these natural-language instructions`))
  assert.ok(!calls[0].prompt.includes(verifier))
  assert.ok(calls[1].prompt.includes(`SKILL INSTRUCTIONS\n${verifier}\n\nInterpret these natural-language instructions`))
  assert.ok(!calls[1].prompt.includes(worker))
  assert.match(calls[0].prompt, /Evaluate each condition first, then select only the applicable relevant skills/)
  const names = { skills: { worker: 'ponytail:ponytail, ui:ux', verifier: 'verify:review' } }
  const named = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], names)
  assert.match(named.calls[0].prompt, /SKILL INSTRUCTIONS\nponytail:ponytail, ui:ux\n/)
  assert.match(named.calls[1].prompt, /SKILL INSTRUCTIONS\nverify:review\n/)
  for (const extra of [{}, { skills: { worker: '${user_config.worker_skills}', verifier: '' } }]) {
    const r = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], extra)
    assert.doesNotMatch(r.calls[0].prompt, /SKILL INSTRUCTIONS/)
    assert.doesNotMatch(r.calls[1].prompt, /SKILL INSTRUCTIONS/)
  }
})

test('SETUP stages the setup patch after applying it, only when there is one', async () => {
  const steps = () => [{ label: 'worker', result: done }, { label: 'verify', result: pass }]
  const withPatch = await runWith(steps(), { baseCommit: 'abc', setupPatch: '/p/setup.patch' })
  const setup = withPatch.calls[0].prompt.split('SETUP')[1]
  assert.ok(setup.indexOf('git apply') > 0 && setup.indexOf('git add -A') > setup.indexOf('git apply'))
  assert.match(withPatch.calls[0].prompt, /no `git add`/)
  assert.match(withPatch.calls[1].prompt, /starting changes are staged/)
  const without = await runWith(steps(), { baseCommit: 'abc' })
  assert.ok(!without.calls[0].prompt.split('SETUP')[1].includes('git add -A'))
})

test('workflow script never reads the clock (Workflow forbids Date)', () => {
  assert.doesNotMatch(src, /new Date\(|Date\.now\(/)
})

test('router prompt asks for targeted tests and judges only from the task and repo', async () => {
  const { calls } = await routeThenPass(routed)
  const prompt = calls[0].prompt
  assert.match(prompt, /only targeted, fast existing tests/)
  assert.match(prompt, /leave the full suite to CI/)
  assert.match(prompt, /Never run node --test <directory>/)
  assert.match(prompt, /task text already gives a verify command, use it as given/)
  assert.match(prompt, /Judge only from the TASK text and the repo contents/)
  assert.match(prompt, /Do not read session transcripts or any file outside the repo/)
  assert.match(prompt, /Numbers in the TASK \(1, 2, 3\.\.\.\) refer only to items within that task/)
})
