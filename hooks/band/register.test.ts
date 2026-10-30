import { expect, mock, test } from 'claude-code/testing'

for (const scenario of [
  { name: 'matching project', instructions: 'model-ladder: use plugin:skill\nother: wrong project\nmodel-ladder: when coding', expected: 'worker use plugin:skill\nwhen coding' },
  { name: 'other project', instructions: 'other: wrong project', expected: null },
  { name: 'global instruction', instructions: 'use ponytail', expected: 'worker use ponytail' },
]) {
  test(`instruction disclosure: ${scenario.name}`, async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/home/test' })
    on('session.cwd', () => ({ value: '/repos/model-ladder' }))
    on('session.repo', () => ({ value: { root: '/repos/model-ladder', remote: null } }))
    on('session.usage', () => ({ value: { rateLimits: [] } }))
    on('fs.read', ($, e) => {
      return e.path.replace(/\\/g, '/').endsWith('/repos/model-ladder/.claude/model-ladder.json')
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
      expect(await ui.find({ type: 'Text', text: /skill instructions:|wrong project|model-ladder:/ })).toBeUndefined()
      if (scenario.expected === null) {
        expect(await ui.find({ key: 'skills-fold' })).toBeUndefined()
      } else {
        expect(await ui.find({ type: 'Text', text: scenario.expected.replace(/\s+/g, ' ') })).toMatchObject({ props: { wrap: 'truncate-end' } })
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▾' } })
        expect((await ui.find({ type: 'Text', text: scenario.expected }))?.props.wrap).toBeUndefined()
        await ui.press({ key: 'skills-fold' })
        expect(await ui.find({ key: 'skills-fold' })).toMatchObject({ props: { label: '▸' } })
      }
      await ui.unmount()
    }
  })
}
