import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { displayWidth, truncate, renderLive, visibleAgents } from '../../scripts/codex-live.mjs'
import { configureGuard, parseArgs } from '../../scripts/watch.mjs'

test('truncation counts Chinese as two cells and preserves graphemes and single-line output', () => {
  assert.equal(displayWidth('整理 README'), 11)
  assert.equal(truncate('整理 README 文件', 10), '整理 READ…')
  assert.equal(truncate('中文', 2), '…')
  assert.equal(truncate('中文', 4), '中文')
  assert.equal(truncate('e\u0301中文', 4), 'e\u0301中…')
  assert.equal(truncate('🙂中文', 4), '🙂…')
  assert.equal(truncate('中文', 0), '')
  assert.equal(truncate('a\nb\t\x1b[31mc', 20), 'a b c')
})
test('completed rows freeze elapsed time and disappear at ten seconds; active rows remain', () => {
  const start = Date.parse('2026-10-23T00:00:00Z')
  const done = { phase: 'worker', model: 'luna', effort: 'low', task: '整理中文 README'.repeat(8), startedAt: new Date(start).toISOString(), endedAt: new Date(start + 5000).toISOString(), pass: true }
  const state = { agents: [done], usage: { fiveHour: 15, sevenDay: 44 } }
  const frame = renderLive(state, { now: start + 14999, width: 50 })
  assert.match(frame, /✓ 5s/)
  assert.match(frame, /5h 15% · 7d 44% · idle/)
  assert.ok(frame.split('\n').every((line) => displayWidth(line) <= 50))
  assert.match(frame, /…/)
  assert.equal(visibleAgents([done], start + 15000).length, 0)
  assert.doesNotMatch(renderLive(state, { now: start + 15000 }), /luna/)
  assert.equal(renderLive(state, { now: start + 15000 }).split('\n')[1], frame.split('\n')[1])
  const running = { ...done, endedAt: null, pass: null }
  assert.equal(visibleAgents([running], start + 50000).length, 1)
  assert.match(renderLive({ agents: [running] }, { now: start + 12000, guard: { enabled: false } }), /12s/)
  assert.doesNotMatch(renderLive({ agents: [running] }, { now: start + 12000, guard: { enabled: false } }), /idle|threshold/)
})
test('watch flags preserve other configuration; every invalid threshold exits without writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ml-watch-'))
  try {
    mkdirSync(join(root, '.codex'))
    const path = join(root, '.codex/model-ladder.json')
    const config = { router: { model: 'custom', effort: 'low' }, extra: [1, 2], usageGuard: { enabled: true, threshold: 90, extra: 'keep' } }
    writeFileSync(path, JSON.stringify(config))
    configureGuard(root, parseArgs(['--guard', 'off', '--threshold', '75']))
    assert.deepEqual(JSON.parse(readFileSync(path)), { ...config, usageGuard: { enabled: false, threshold: 75, extra: 'keep' } })
    for (const value of ['0', '101', '-1', 'NaN', 'Infinity', 'no', '90oops', '1e2', '']) {
      const before = readFileSync(path, 'utf8')
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/watch.mjs', import.meta.url)), '--cwd', root, '--guard', 'on', '--threshold', value], { encoding: 'utf8' })
      assert.equal(result.status, 1, value)
      assert.match(result.stderr, /threshold/)
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    for (const value of ['1', '100', '90.5']) assert.equal(parseArgs(['--threshold', value]).threshold, Number(value))
    assert.throws(() => parseArgs(['--guard', 'yes']), /on or off/)
    assert.throws(() => parseArgs(['--threshold']), /requires/)
    assert.throws(() => configureGuard(root, { threshold: NaN }), /between/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
