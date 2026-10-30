import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { readCodexUsage } from '../../scripts/codex-usage.mjs'
import { usageSnapshot } from '../../scripts/forecast.mjs'

const dirs = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'ml-usage-')); dirs.push(dir); return dir }
const event = (primary, secondary) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { x: 1 }, rate_limits: { primary, secondary } } })
const session = (dir, name, lines, time) => {
  const file = join(dir, 'sessions/2026/10', name)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n')
  utimesSync(file, time, time)
}
const future = Math.floor(Date.now() / 1000) + 3600
const past = Math.floor(Date.now() / 1000) - 3600

test('reads the last rate_limits of the newest session and takes the max live window', () => {
  const dir = home()
  session(dir, 'old.jsonl', [event({ used_percent: 99, resets_at: future }, null)], 1000)
  session(dir, 'new.jsonl', [event({ used_percent: 10, resets_at: future }, null), '{"type":"other"}', event({ used_percent: 96, resets_at: future }, { used_percent: 31, resets_at: future }), 'not json rate_limits'], 2000)
  assert.equal(readCodexUsage(dir), 96)
})
test('expired windows are ignored and all-expired is unknown', () => {
  const dir = home()
  session(dir, 'a.jsonl', [event({ used_percent: 96, resets_at: past }, { used_percent: 31, resets_at: future })], 1000)
  assert.equal(readCodexUsage(dir), 31)
  session(dir, 'b.jsonl', [event({ used_percent: 96, resets_at: past }, { used_percent: 31, resets_at: past })], 2000)
  assert.equal(readCodexUsage(dir), null)
})
test('no sessions returns null', () => assert.equal(readCodexUsage(home()), null))
test('details distinguish window durations, expired and unknown data without changing guard behavior', () => {
  const dir = home()
  const details = () => readCodexUsage(dir, undefined, { details: true })
  assert.deepEqual(details(), { fiveHour: null, sevenDay: null })
  session(dir, 'a.jsonl', [event({ used_percent: 44, resets_at: future, window_minutes: 10080 }, { used_percent: 15, resets_at: future, window_minutes: 300 })], 1000)
  assert.deepEqual(details(), { fiveHour: 15, sevenDay: 44 })
  assert.equal(readCodexUsage(dir), 44)
  session(dir, 'b.jsonl', [event({ used_percent: 99, resets_at: future, window_minutes: 60 }, { used_percent: 15, resets_at: past, window_minutes: 300 })], 2000)
  assert.deepEqual(details(), { fiveHour: null, sevenDay: null })
  assert.equal(readCodexUsage(dir), 99)
})

test('panel usage includes the reset timestamp of each labelled window on request', () => {
  const dir = home()
  session(dir, 'a.jsonl', [event({ used_percent: 15, resets_at: future, window_minutes: 300 }, null)], 1000)
  assert.deepEqual(readCodexUsage(dir, undefined, { details: true, resets: true }), { fiveHour: 15, sevenDay: null, fiveHourResetsAt: future, sevenDayResetsAt: null })
})

test('forecast evidence retains sample time, source and every subscription window without changing the guard', () => {
  const dir = home()
  const raw = JSON.parse(event({ used_percent: 15, resets_at: future, window_minutes: 300 }, { used_percent: 8, resets_at: future, window_minutes: 60 }))
  raw.timestamp = '2026-10-29T10:00:00.000Z'
  session(dir, 'evidence.jsonl', [JSON.stringify(raw)], 1000)
  const evidence = readCodexUsage(dir, undefined, { evidence: true })
  assert.equal(evidence.sampledAt, Date.parse(raw.timestamp))
  assert.equal(evidence.windows.five_hour.used, 15)
  assert.equal(evidence.windows['60_minutes'].resetsAt, future * 1000)
  assert.match(evidence.source, /evidence.jsonl$/)
  assert.equal(readCodexUsage(dir), 15)
  delete raw.timestamp
  session(dir, 'missing-time.jsonl', [JSON.stringify(raw)], 2000)
  assert.equal(readCodexUsage(dir, undefined, { evidence: true }).sampledAt, null)
})

test('Claude forecast reads additional subscription windows from the existing usage cache', () => {
  const dir = home(), now = Date.now()
  mkdirSync(join(dir, '.model-ladder'), { recursive: true })
  writeFileSync(join(dir, '.model-ladder/usage.json'), JSON.stringify({ updatedAt: now / 1000, daily: { used_percentage: 12, resets_at: now / 1000 + 3600 } }))
  assert.equal(usageSnapshot(dir, 'claude', now).windows.daily.used, 12)
  assert.equal(usageSnapshot(dir, 'claude', now + 900001).sampledAt, null)
})
