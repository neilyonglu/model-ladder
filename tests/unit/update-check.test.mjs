import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { compareVersions, installedVersion, updateNote } from '../../scripts/update-check.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ml-update-'))
after(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
const cachePath = () => join(dir, `cache-${n++}.json`)
const DAY = 24 * 60 * 60 * 1000

test('compares x.y.z versions numerically', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('garbage', '1.0.0'), 0)
})

test('reads the installed version from plugin.json', () => {
  assert.match(installedVersion(), /^\d+\.\d+\.\d+$/)
})

test('a newer published version produces the update line', async () => {
  const note = await updateNote({ current: '0.1.1', latest: async () => '0.2.0', cachePath: cachePath(), env: {} })
  assert.equal(note, 'model-ladder 0.2.0 is available (you have 0.1.1). Update: claude plugin update model-ladder@model-ladder')
})

test('same or older published version says nothing', async () => {
  assert.equal(await updateNote({ current: '0.1.1', latest: async () => '0.1.1', cachePath: cachePath(), env: {} }), null)
  assert.equal(await updateNote({ current: '0.2.0', latest: async () => '0.1.1', cachePath: cachePath(), env: {} }), null)
})

test('checks the network at most once a day', async () => {
  const path = cachePath()
  let calls = 0
  const latest = async () => (calls++, '0.2.0')
  await updateNote({ current: '0.1.1', latest, cachePath: path, now: 0, env: {} })
  await updateNote({ current: '0.1.1', latest, cachePath: path, now: DAY - 1, env: {} })
  assert.equal(calls, 1)
  await updateNote({ current: '0.1.1', latest, cachePath: path, now: DAY + 1, env: {} })
  assert.equal(calls, 2)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).latest, '0.2.0')
})

test('network failure and opt-out are silent', async () => {
  const offline = async () => { throw new Error('offline') }
  assert.equal(await updateNote({ current: '0.1.1', latest: offline, cachePath: cachePath(), env: {} }), null)
  let called = false
  const note = await updateNote({ current: '0.1.1', latest: async () => (called = true, '9.9.9'), cachePath: cachePath(), env: { MODEL_LADDER_NO_UPDATE_CHECK: '1' } })
  assert.equal(note, null)
  assert.equal(called, false)
})
