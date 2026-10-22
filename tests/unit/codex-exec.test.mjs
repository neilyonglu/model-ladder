import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { codexExec, EnvironmentError, processRun } from '../../scripts/codex-exec.mjs'

const partialOutput = `
  const bytes = Buffer.from('中文🙂');
  process.stdout.write(bytes.subarray(0, 1));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(1));
    process.stderr.write('診斷🙂');
  }, 30);
  setInterval(() => {}, 1000);
`

test('timeout preserves decoded Unicode from split UTF-8 chunks', async () => {
  await assert.rejects(processRun(process.execPath, ['-e', partialOutput], { timeoutMs: 1500 }), (error) => {
    assert.ok(error instanceof EnvironmentError)
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.stdout, '中文🙂')
    assert.equal(error.stderr, '診斷🙂')
    return true
  })
})

test('cancellation retains output from the running child', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ladder-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ready = join(dir, 'ready')
  const controller = new AbortController()
  const script = `process.stdout.write('取消🙂', () => require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready')); setInterval(() => {}, 1000)`
  const pending = processRun(process.execPath, ['-e', script], { signal: controller.signal, timeoutMs: 10000 })
  const rejected = assert.rejects(pending, (error) => {
    assert.equal(error.code, 'CANCELLED')
    assert.equal(error.stdout, '取消🙂')
    return true
  })
  for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(20)
  controller.abort()
  await rejected
  assert.ok(existsSync(ready), 'child produced output before cancellation')
})

test('pre-cancelled execution reports empty captured streams', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(processRun(process.execPath, [], { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'CANCELLED')
    assert.equal(error.stdout, '')
    assert.equal(error.stderr, '')
    return true
  })
})

test('captured output stays bounded without splitting surrogate pairs', async () => {
  const script = "process.stdout.write('🙂'.repeat(70000) + 'a'); process.stderr.write('🙂'.repeat(10000) + 'b')"
  const result = await processRun(process.execPath, ['-e', script])
  assert.equal(result.code, 0)
  assert.ok(result.stdout.length <= 131072)
  assert.ok(result.stderr.length <= 16384)
  assert.ok(result.stdout.isWellFormed())
  assert.ok(result.stderr.isWellFormed())
  assert.ok(result.stdout.endsWith('🙂a'))
  assert.ok(result.stderr.endsWith('🙂b'))
})

test('codex timeout persists partial events and stderr with phase context', async (t) => {
  const run = mkdtempSync(join(tmpdir(), 'ladder-timeout-'))
  t.after(() => rmSync(run, { recursive: true, force: true }))
  const stdout = '{"type":"thread.started","thread_id":"途中🙂"}\n'
  const stderr = '途中診斷🙂'
  const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); setInterval(() => {}, 1000)`
  await assert.rejects(codexExec({
    phase: 'worker', cell: { model: 'test', effort: 'low' }, cwd: run, run,
    prompt: 'test', sandbox: 'read-only', timeoutMs: 1500,
    executable: { command: process.execPath, prefixArgs: ['-e', script, '--'] },
  }), (error) => {
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.phase, 'worker')
    assert.equal(error.cwd, run)
    return true
  })
  const files = readdirSync(run)
  const eventsFile = files.find((file) => file.endsWith('.events.jsonl'))
  assert.ok(eventsFile, 'partial event log exists')
  assert.equal(readFileSync(join(run, eventsFile), 'utf8'), stdout)
  assert.equal(readFileSync(join(run, eventsFile.replace('.events.jsonl', '.stderr.txt')), 'utf8'), stderr)
})
