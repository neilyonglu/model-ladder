import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, after } from 'node:test'
import { runLadder } from '../../scripts/codex-run.mjs'
import { artifactDir } from '../../scripts/common.mjs'

const dirs = []
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'ladder-no-usage-'))
after(() => { for (const dir of dirs) { rmSync(artifactDir(dir), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) } })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const fake = fileURLToPath(new URL('../helpers/fake-codex.mjs', import.meta.url))
const PARTS = [{ task: 'Fix the greeting', scope: ['greeting.mjs'] }, { task: 'Add a check', scope: ['tests/check.test.mjs'] }]
function fixture(scenario, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-split-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'config', 'user.email', 't@example.test')
  git(dir, 'config', 'core.autocrlf', 'false')
  const write = (file, value) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), value) }
  write('.gitignore', '.model-ladder/\n')
  write('greeting.mjs', 'export default "Wellcome"\n')
  write('tests/check.test.mjs', 'import assert from "node:assert/strict"\nimport greeting from "../greeting.mjs"\nassert.equal(greeting,"Welcome")\n')
  write('scenario.json', JSON.stringify(scenario))
  write('.codex/model-ladder.json', JSON.stringify({
    router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' },
    tiers: [{ model: 'cheap', efforts: ['low', 'medium', 'high'], maxEffortJump: 1 }, { model: 'strong', efforts: ['low', 'high'], maxEffortJump: 1 }],
    verify: 'node --test tests/check.test.mjs', maxAttempts: 3, ...overrides,
  }))
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'fixture')
  return dir
}
const run = (cwd, input = {}) => runLadder({ task: 'Fix greeting typo', ...input }, { cwd, executable: { command: process.execPath, prefixArgs: [fake, cwd] } })

test('over the limit with parts returns NEEDS_INPUT SPLIT and runs no worker', async () => {
  const dir = fixture({ estimatedMinutes: 21, split: PARTS })
  const result = await run(dir)
  assert.equal(result.status, 'NEEDS_INPUT', JSON.stringify(result))
  assert.equal(result.reason, 'SPLIT')
  assert.deepEqual(result.splitSuggestion, { estimatedMinutes: 21, limit: 20, parts: PARTS })
  assert.equal(result.attempts.length, 0)
})
test('exactly the limit does not trigger', async () => {
  const result = await run(fixture({ estimatedMinutes: 20, split: PARTS }))
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
})
test('a configured limit replaces the default', async () => {
  const result = await run(fixture({ estimatedMinutes: 11, split: PARTS }, { split_minutes: 10 }))
  assert.equal(result.reason, 'SPLIT')
  assert.equal(result.splitSuggestion.limit, 10)
})
test('split_minutes off never triggers', async () => {
  const result = await run(fixture({ estimatedMinutes: 500, split: PARTS }, { split_minutes: 'off' }))
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
})
test('an empty split never triggers', async () => {
  const result = await run(fixture({ estimatedMinutes: 500, split: [] }))
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
})
test('acceptSplit false skips the check', async () => {
  const result = await run(fixture({ estimatedMinutes: 500, split: PARTS }), { acceptSplit: false })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
})
test('an invalid split_minutes returns ERROR', async () => {
  for (const bad of [0, -5, 'soon']) {
    const result = await run(fixture({}, { split_minutes: bad }))
    assert.equal(result.status, 'ERROR', JSON.stringify(result))
    assert.match(result.message, /split_minutes must be a number of minutes greater than 0, or "off"/)
  }
})
test('the codex router prompt asks for targeted tests and judges only from the task and repo', async () => {
  const dir = fixture({ estimatedMinutes: 1, split: [] })
  await run(dir)
  const calls = readFileSync(join(dir, '.model-ladder', 'fake-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const prompt = calls.find((c) => c.phase === 'route').prompt
  assert.match(prompt, /only targeted, fast existing tests/)
  assert.match(prompt, /leave the full suite to CI/)
  assert.match(prompt, /Never run node --test <directory>/)
  assert.match(prompt, /task text already gives a verify command, use it as given/)
  assert.match(prompt, /Judge only from the TASK text and the repo contents/)
  assert.match(prompt, /Do not read session transcripts or any file outside the repo/)
  assert.match(prompt, /Numbers in the TASK \(1, 2, 3\.\.\.\) refer only to items within that task/)
})
