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
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, isolation: opts.isolation, agentType: opts.agentType, prompt })
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
  assert.deepEqual(out.winner, { worktreePath: '/wt', filesChanged: ['a.py'] })
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
  acceptance: [], allowTests: false, allowTestsReason: 'bug fix', question: null,
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
})

test('a vague task returns the router question', async () => {
  const { out } = await routeOnly({ ...routed, question: 'Better how?' })
  assert.equal(out.status, 'NEEDS_INPUT')
  assert.equal(out.plan.question, 'Better how?')
})

test('a router that fails to report stops the run', async () => {
  await assert.rejects(call([{ label: 'route', throws: 'boom' }]), /the router failed: boom/)
})
