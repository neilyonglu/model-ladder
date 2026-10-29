import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readClaudeUsage } from '../../scripts/usage-statusline.mjs'

const script = fileURLToPath(new URL('../../scripts/usage-statusline.mjs', import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ml-usage-'))
  dirs.push(d)
  return d
}
const run = (dir, input, ...args) => spawnSync('node', [script, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })

const NOW = 1_000_000
const saved = (dir, data) => {
  const file = join(dir, 'model-ladder-usage.json')
  writeFileSync(file, JSON.stringify(data))
  return file
}

test('rate_limits on stdin: writes the usage file and prints both windows', () => {
  const dir = tmp()
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2e9 }, seven_day: { used_percentage: 13, resets_at: 2e9 + 1 } } })
  const out = run(dir, input)
  assert.equal(out.status, 0)
  assert.equal(out.stdout.trim(), '5h 42% · 7d 13%')
  const data = JSON.parse(readFileSync(join(dir, 'model-ladder-usage.json'), 'utf8'))
  assert.equal(data.five_hour.used_percentage, 42)
  assert.equal(data.seven_day.resets_at, 2e9 + 1)
  assert.ok(Math.abs(data.updatedAt - Date.now() / 1000) < 60)
})

test('one window missing: still writes and prints the other', () => {
  const dir = tmp()
  const out = run(dir, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 7, resets_at: 2e9 } } }))
  assert.equal(out.stdout.trim(), '7d 7%')
  assert.equal(JSON.parse(readFileSync(join(dir, 'model-ladder-usage.json'), 'utf8')).five_hour, null)
})

test('no rate_limits or non-JSON stdin: nothing written, no crash', () => {
  for (const input of [JSON.stringify({ model: 'x' }), 'not json', '']) {
    const dir = tmp()
    const out = run(dir, input)
    assert.equal(out.status, 0)
    assert.equal(out.stdout.trim(), '')
    assert.equal(existsSync(join(dir, 'model-ladder-usage.json')), false)
  }
})

test('readClaudeUsage: the highest unexpired window, null when unknown', () => {
  const dir = tmp()
  const win = (p, resets) => ({ used_percentage: p, resets_at: resets })
  const fresh = { updatedAt: NOW - 60 }
  assert.equal(readClaudeUsage(join(dir, 'missing.json'), NOW), null)
  assert.equal(readClaudeUsage(saved(dir, { ...fresh, five_hour: win(42, NOW + 100), seven_day: win(13, NOW + 100) }), NOW), 42)
  // An expired window no longer counts, even when it is the highest.
  assert.equal(readClaudeUsage(saved(dir, { ...fresh, five_hour: win(99, NOW - 1), seven_day: win(13, NOW + 100) }), NOW), 13)
  assert.equal(readClaudeUsage(saved(dir, { ...fresh, five_hour: win(99, NOW - 1), seven_day: win(13, NOW) }), NOW), null)
  assert.equal(readClaudeUsage(saved(dir, { ...fresh, five_hour: win(50, NOW + 100), seven_day: null }), NOW), 50)
  assert.equal(readClaudeUsage(saved(dir, { updatedAt: NOW - 15 * 60 - 1, five_hour: win(50, NOW + 100) }), NOW), null)
  assert.equal(readClaudeUsage(saved(dir, { updatedAt: NOW - 15 * 60, five_hour: win(50, NOW + 100) }), NOW), 50)
  writeFileSync(join(dir, 'bad.json'), '{oops')
  assert.equal(readClaudeUsage(join(dir, 'bad.json'), NOW), null)
})

test('--percent prints the number, or unknown', () => {
  const dir = tmp()
  assert.equal(run(dir, '', '--percent').stdout.trim(), 'unknown')
  run(dir, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 2e9 }, seven_day: { used_percentage: 61, resets_at: 2e9 } } }))
  assert.equal(run(dir, '', '--percent').stdout.trim(), '61')
  saved(dir, { updatedAt: 1, five_hour: { used_percentage: 42, resets_at: 2e9 } })
  assert.equal(run(dir, '', '--percent').stdout.trim(), 'unknown')
})
