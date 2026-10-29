import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = (file) => readFileSync(join(root, file), 'utf8')
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-handoff-'))
  dirs.push(dir)
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  mkdirSync(join(dir, '.model-ladder'))
  return dir
}
const finish = (dir, args, input) => spawnSync('node', [join(root, 'scripts/finish.mjs'), ...args], {
  cwd: dir, input, encoding: 'utf8', env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
})

test('finish still writes the template HANDOFF.md on USAGE_LIMIT', () => {
  const dir = repo()
  const result = {
    status: 'USAGE_LIMIT', winner: null, tokens: 1,
    plan: { goal: 'g', verify: 'pytest', allowTests: false, allowTestsReason: 'r', start: 'haiku/low', startReason: 'r' },
    attempts: [{ cell: 'haiku/low', pass: false, reason: 'tests fail', tokens: 1 }],
    final: { reason: 'usage 95% reached the threshold of 90%', suggestion: 'later' },
  }
  const out = finish(dir, [], JSON.stringify({ task: 'fix b', result }))
  assert.equal(out.status, 0, out.stdout + out.stderr)
  const text = readFileSync(join(dir, '.model-ladder', 'HANDOFF.md'), 'utf8')
  assert.match(text, /^# model-ladder handoff\n/)
  assert.match(text, /USAGE_LIMIT: usage 95% reached/)
  assert.match(text, /1\. haiku\/low: FAIL tests fail/)
  assert.match(text, /\/model-ladder:run fix b/)
})

test('finish --handoff writes a template from the last history entry, and says so when there is none', () => {
  const dir = repo()
  const none = finish(dir, ['--handoff'], '')
  assert.equal(none.status, 0, none.stdout + none.stderr)
  assert.match(none.stdout, /no run history/)
  assert.ok(!existsSync(join(dir, '.model-ladder', 'HANDOFF.md')))

  const entry = { date: '2026-10-28T00:00:00.000Z', task: 'fix b', status: 'FAILED', attempts: [{ cell: 'sonnet/low', pass: false, reason: 'still red' }], winner: null, kept: [] }
  writeFileSync(join(dir, '.model-ladder', 'history.jsonl'), `${JSON.stringify({ ...entry, task: 'older' })}\n${JSON.stringify(entry)}\n`)
  const out = finish(dir, ['--handoff'], '')
  assert.equal(out.status, 0, out.stdout + out.stderr)
  const text = readFileSync(join(dir, '.model-ladder', 'HANDOFF.md'), 'utf8')
  assert.match(text, /## Task\nfix b\n/)
  assert.match(text, /Manual handoff \(last run ended FAILED/)
  assert.match(text, /1\. sonnet\/low: FAIL still red/)
  assert.match(text, /To start the task again, run `\/model-ladder:run fix b`/)
  assert.doesNotMatch(text, /usage limit resets/)
})

test('handoff skill has valid frontmatter and the AI-written format', () => {
  const text = read('skills/handoff/SKILL.md')
  const front = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(front, 'frontmatter present')
  assert.match(front[1], /^name: handoff$/m)
  assert.match(front[1], /^description: .{20,}/m)
  assert.match(text, /finish\.mjs" --handoff/)
  for (const section of ['Goal', 'User preferences and decisions', 'Done and not done', 'Suggested next steps', 'How to resume']) assert.ok(text.includes(`## ${section}`), section)
  assert.match(text, /## Appendix: program-generated verification \(authoritative\)/)
  assert.match(text, /language the user uses/)
})

test('run SKILL.md: availability check after preflight, AI handoff on USAGE_LIMIT, capability blockers', () => {
  const text = read('skills/run/SKILL.md')
  const check = text.indexOf('Availability check')
  assert.ok(check > text.indexOf('## 1. Preflight') && check < text.indexOf('## 2. Workflow'))
  assert.match(text, /not available in this project/)
  assert.match(text, /Do not stop the run/)
  assert.match(text, /Capability blockers/)
  const finishStep = text.slice(text.indexOf('## 3. Finish'))
  assert.match(finishStep, /write the real one yourself/)
  assert.match(finishStep, /\.model-ladder\/HANDOFF\.md/)
  assert.match(finishStep, /Appendix: program-generated verification \(authoritative\)/)
  assert.match(finishStep, /language the user uses in this session/)
  assert.match(finishStep, /leave the template as it is/)
})

test('codex SKILL.md: availability check, USAGE_LIMIT and requested handoff, template fallback', () => {
  const text = read('codex-skills/model-ladder/SKILL.md')
  assert.match(text, /Availability check, before the run/)
  assert.match(text, /not available in this project/)
  assert.match(text, /do not stop the run/)
  assert.match(text, /capability blockers/)
  assert.match(text, /USAGE_LIMIT, or the user asks for a handoff/)
  assert.match(text, /rewrite `\.model-ladder\/HANDOFF\.md` yourself/)
  assert.match(text, /Appendix: program-generated verification \(authoritative\)/)
  assert.match(text, /hard usage limit and you cannot call the model again, keep the template/)
  // The numbered steps stay consecutive.
  const steps = [...text.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
  assert.deepEqual(steps, steps.map((_, i) => i + 1))
})

test('band handoff button writes the template, then submits /model-ladder:handoff with a toast fallback', () => {
  const text = read('hooks/band/register.tsx')
  assert.match(text, /HANDOFF_COMMAND = '\/model-ladder:handoff'/)
  assert.match(text, /\$\.prompt\.submit\(\{ text: HANDOFF_COMMAND, asUser: true \}\)/)
  assert.ok(text.indexOf('handoffText(live') < text.indexOf('$.prompt.submit'), 'template first')
  assert.match(text, /run \$\{HANDOFF_COMMAND\} for the AI-written version/)
})

test('docs mention the AI-written handoff and the availability warning in both languages', () => {
  for (const file of ['README.md', 'README.zh-TW.md', 'DESIGN.md', 'DESIGN.zh-TW.md']) {
    assert.match(read(file), /\/model-ladder:handoff/, file)
  }
  for (const file of ['README.md', 'README.zh-TW.md']) assert.match(read(file), /ponytail` (is not available|在這個專案無法使用)/, file)
  for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-TW.md']) {
    const changelog = read(file)
    assert.match(changelog, /\/model-ladder:handoff/, file)
    assert.match(changelog, /HANDOFF\.md/, file)
    assert.match(changelog, /worker_skills/, file)
  }
})
