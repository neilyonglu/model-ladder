import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import { readCodexUsage } from '../../scripts/codex-usage.mjs'

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
