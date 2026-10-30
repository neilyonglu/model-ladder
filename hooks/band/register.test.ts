import { expect, mock, test } from 'claude-code/testing'

for (const scenario of [
  { name: 'matching project', instructions: 'model-ladder: use ponytail when coding\nother: wrong project', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: ponytail / coding' },
  { name: 'other project', instructions: 'other: wrong project', project: 'model-ladder', root: '/repos/model-ladder', expected: null },
  { name: 'global instruction', instructions: 'use ponytail when coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: ponytail / coding' },
  { name: 'compact namespaced skill', instructions: 'model-ladder: plugin:code-review / code-review/coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: plugin:code-review / code-review/coding' },
  { name: 'natural language and multiple lines', instructions: 'model-ladder: Follow docs: read /docs and use plugin:skill\nuse ponytail when coding', project: 'model-ladder', root: '/repos/model-ladder', expected: 'model-ladder: Follow docs: read /docs and use plugin:skill\nmodel-ladder: ponytail / coding' },
  { name: 'cwd project fallback', instructions: 'use ponytail when coding', project: 'fallback', root: null, expected: 'fallback: ponytail / coding' },
]) {
  test(`instruction disclosure: ${scenario.name}`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/test' })
    on('session.cwd', () => ({ value: `/repos/${scenario.project}` }))
    on('session.repo', () => ({ value: { root: scenario.root, remote: null } }))
    on('session.usage', () => ({ value: { rateLimits: [] } }))
    on('fs.read', ($, e) => {
      return e.path.replace(/\\/g, '/').endsWith(`/repos/${scenario.project}/.claude/model-ladder.json`)
        ? { value: JSON.stringify({ worker_skills: scenario.instructions }) }
        : { deny: 'File does not exist' }
    })

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({
        plugin: 'model-ladder', component: 'AbovePrompt', surface,
        requestId: 'band-test', viewport: { columns: 60, rows: 20 },
        props: { hasSurvey: false, isWorking: false, bodyColumns: 60, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect(await ui.find({ key: 'guard' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /skill instructions:|wrong project|worker |verifier / })).toBeUndefined()
      if (scenario.expected === null) {
        expect(await ui.find({ key: 'skills-fold' })).toBeUndefined()
      } else {
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▸' } })
        const foldedLine = scenario.expected.replace(/\s+/g, ' ').slice(0, 20)
        if (scenario.expected.length < 60) {
          expect(await ui.find({ type: 'Text', text: new RegExp(`^${foldedLine}`) })).toMatchObject({ props: { wrap: 'truncate-end' } })
        }
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▾' } })
        const expanded = await ui.find({ type: 'Text', text: scenario.expected })
        expect(expanded).toBeDefined()
        expect(expanded?.props.wrap).toBeUndefined()
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▸' } })
        if (scenario.expected.length < 60) {
          expect(await ui.find({ type: 'Text', text: new RegExp(`^${foldedLine}`) })).toMatchObject({ props: { wrap: 'truncate-end' } })
        }
      }
      await ui.unmount()
    }
  })
}

const BAND = {
  plugin: 'model-ladder', component: 'AbovePrompt', requestId: 'band-test', viewport: { columns: 100, rows: 20 },
  props: { hasSurvey: false, isWorking: false, bodyColumns: 100, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
// The engine hands fs hooks resolved paths: on Windows /repos/app arrives as C:\repos\app.
const slash = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

for (const scenario of [
  { name: 'a .git above the cwd', cwd: '/repos/app/px1', git: '/repos/app/.git', root: '/repos/app' },
  { name: 'no .git anywhere falls back to the cwd', cwd: '/repos/loose/px1', git: null, root: '/repos/loose/px1' },
]) {
  test(`state files go to the repo root .model-ladder: ${scenario.name}`, async ($, on) => {
    mock.clock(on, { now: 1_700_000_000_000 })
    mock.env(on, { HOME: '/home/test' })
    const exists: string[] = []
    const writes: string[] = []
    on('session.cwd', () => ({ value: scenario.cwd }))
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('fs.exists', ($, e) => { exists.push(slash(e.path)); return { value: slash(e.path) === scenario.git } })
    on('fs.write', ($, e) => { writes.push(slash(e.path)); return { value: undefined } })

    const measure = (tokens: number) => $.session.measure({
      context: { tokens, window: 1_000_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
      changed: ['context', 'rateLimits'],
    })
    await measure(1000)
    expect([...writes].sort()).toEqual([`${scenario.root}/.model-ladder/context.json`, `${scenario.root}/.model-ladder/usage.json`])

    // The walk ran once; a later turn in the same cwd reuses it.
    const walked = exists.length
    expect(walked).toBeGreaterThan(0)
    await measure(2000)
    expect(exists.length).toBe(walked)
    expect(writes.length).toBe(4)
  })
}

test('main-session row while a run lock exists and no agent runs; idle once the lock is gone', async ($, on) => {
  const NOW = 1_700_000_000_000
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/test' })
  const startedAt = new Date(NOW - (4 * 60 + 12) * 1000).toISOString()
  let lock: Record<string, unknown> | null = null
  on('session.cwd', () => ({ value: '/repos/app/px2' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs' && lock
    ? { value: [{ name: 'claude-1.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }, { name: 'registry.lock', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs/claude-1.json' && lock
    ? { value: JSON.stringify(lock) }
    : { deny: 'File does not exist' }))

  for (const surface of ['terminal', 'desktop'] as const) {
    lock = { runId: 'claude-1', runtime: 'claude', pid: null, task: 'fix the login bug', phase: 'needs-input', startedAt }
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'main-session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no model' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '4m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs-input: fix the login bug/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· idle/ })).toBeUndefined()
    await ui.unmount()

    lock = { ...lock, phase: 'awaiting-finish' }
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /awaiting-finish: fix the login bug/ })).toBeDefined()
    await ui.unmount()

    // finish removed the lock: the run is over.
    lock = null
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'main-session' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'no model' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /· idle/ })).toBeDefined()
    await ui.unmount()
  }
})

// Locks as scripts/preflight.mjs writes them, expectedMs as scripts/forecast.mjs adds it once routing has a forecast.
const lockFile = (runId: string, task: string, expectedMs?: number) => ({ runId, runtime: 'claude', pid: null, task, phase: 'claimed', startedAt: new Date(1_700_000_000_000 - 60_000).toISOString(), ...(expectedMs && { expectedMs }) })

test('time column shows elapsed/expected for the agent\'s own run, elapsed alone when unknown, and a finished row keeps its value', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const locks: Record<string, Record<string, unknown>> = {
    'claude-a.json': lockFile('claude-a', 'Fix greeting', 720_000),
    'claude-b.json': lockFile('claude-b', 'Other run'),
  }
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: Object.keys(locks).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => {
    const lock = locks[slash(e.path).split('/').at(-1) ?? '']
    return slash(e.path).startsWith('/repos/app/.model-ladder/runs/') && lock ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }
  })
  on('agent.spawn', ($, e) => ({ agentId: e.description, model: 'claude-haiku-5-5' }))
  on('turn.complete', () => ({ text: '' }))
  const spawn = (description: string, task: string, run: string) => $.agent.spawn({ subagentType: 'model-ladder:worker', description, prompt: `TASK (as the user wrote it)\n  ${task}`, workflow: { runId: run } })
  await spawn('first', 'Fix greeting', 'host-a')
  await spawn('second', 'Other run', 'host-b')
  await spawn('third', 'No lock for this one', 'host-c')
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // Only the first run has a forecast; the other two rows must not borrow it.
    expect(await ui.find({ type: 'Text', text: '5s/12m' })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^5s$/ })).toHaveLength(2)
    expect(await ui.findAll({ type: 'Text', text: /^5s\// })).toHaveLength(1)
    await ui.unmount()
  }

  // A later forecast change in the lock does not move a finished row.
  await $.turn.complete({ agentId: 'first', durationMs: 5000, answer: '' })
  locks['claude-a.json'] = lockFile('claude-a', 'Fix greeting', 3_600_000)
  await clock.advance(2000)
  const frozen = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await frozen.find({ type: 'Text', text: '✓ 5s/12m' })).toBeDefined()
  expect(await frozen.find({ type: 'Text', text: /\/1h/ })).toBeUndefined()
  await frozen.unmount()
})

test('time column is wider than 9 and the main-session row shows its run\'s expected total', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.env(on, { HOME: '/home/test' })
  const lock = lockFile('claude-1', 'fix the login bug', 720_000)
  on('session.cwd', () => ({ value: '/repos/app' }))
  on('session.repo', () => ({ value: { root: '/repos/app', remote: null } }))
  on('session.usage', () => ({ value: { rateLimits: [] } }))
  on('fs.exists', ($, e) => ({ value: slash(e.path) === '/repos/app/.git' }))
  on('fs.list', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs'
    ? { value: [{ name: 'claude-1.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
    : { deny: 'No such directory' }))
  on('fs.read', ($, e) => (slash(e.path) === '/repos/app/.model-ladder/runs/claude-1.json' ? { value: JSON.stringify(lock) } : { deny: 'File does not exist' }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '1m/12m' })).toBeDefined()
  const main = await ui.find({ key: 'main-session' })
  expect(main?.children?.[1]?.props.width).toBeGreaterThan(9)
  await ui.unmount()
})
