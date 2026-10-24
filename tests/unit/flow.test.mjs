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
  assert.match(out.plan.directReason, /45000 tokens of context, not above the 300000 threshold/)
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

test('forceLadder overrides DIRECT', async () => {
  const { out } = await routeThenPass({ ...routed, small: true }, { contextTokens: 400000, forceLadder: true })
  assert.equal(out.status, 'VERIFIED')
})

test('a router that fails to report stops the run', async () => {
  await assert.rejects(call([{ label: 'route', throws: 'boom' }]), /the router failed: boom/)
})

const usageGuard = { threshold: 90, command: 'node "/p/usage-statusline.mjs" --percent' }

test('usageGuard off: the verifier prompt and schema are unchanged', async () => {
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }])
  assert.doesNotMatch(calls[1].prompt, /usage/)
  assert.deepEqual(calls[1].schema.required, ['pass', 'reason', 'output'])
  assert.equal('usage' in calls[1].schema.properties, false)
})

test('usageGuard on: the verifier runs the command last and must report usage', async () => {
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage: '10' } }], { usageGuard })
  assert.ok(calls[1].prompt.trimEnd().endsWith(`run \`${usageGuard.command}\` and put its output unchanged in the usage field.`))
  assert.deepEqual(calls[1].schema.required, ['pass', 'reason', 'output', 'usage'])
  assert.deepEqual(calls[1].schema.properties.usage, { type: 'string' })
})

test('usageGuard on: a failed attempt at the threshold stops with USAGE_LIMIT, no diagnosis', async () => {
  const { out } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage: '92.5' } }], { usageGuard })
  assert.equal(out.status, 'USAGE_LIMIT')
  assert.equal(out.winner, null)
  assert.equal(out.final.reason, 'Claude usage 92.5% reached the usageGuard threshold of 90%.')
  assert.match(out.final.suggestion, /HANDOFF\.md/)
  assert.deepEqual(out.attempts.map((a) => [a.pass, a.worktreePath]), [[false, '/wt']])
})

test('usageGuard on: below the threshold or unknown usage keeps escalating', async () => {
  for (const usage of ['89', 'unknown', '']) {
    const { out } = await runWith([
      { label: 'worker', result: done }, { label: 'verify', result: { ...fail, usage } },
      { label: 'diagnose', result: diag('raise_effort', 'haiku', 'medium') },
      { label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage } },
    ], { usageGuard })
    assert.equal(out.status, 'VERIFIED', usage)
  }
})

test('usageGuard on: a passing attempt is VERIFIED even above the threshold', async () => {
  const { out } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: { ...pass, usage: '99' } }], { usageGuard })
  assert.equal(out.status, 'VERIFIED')
})

test('SKILLS section lists the parsed skills, and is absent when missing or unsubstituted', async () => {
  const skills = { worker: ' a:a, ,b ', verifier: 'v:v' }
  const { calls } = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], { skills })
  assert.match(calls[0].prompt, /SKILLS\n  Before starting, load each with the Skill tool: a:a, b\n/)
  assert.match(calls[1].prompt, /SKILLS\n  Before starting, load each with the Skill tool: v:v/)
  for (const extra of [{}, { skills: { worker: '${user_config.worker_skills}', verifier: '' } }]) {
    const r = await runWith([{ label: 'worker', result: done }, { label: 'verify', result: pass }], extra)
    assert.doesNotMatch(r.calls[0].prompt, /SKILLS/)
    assert.doesNotMatch(r.calls[1].prompt, /SKILLS/)
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
