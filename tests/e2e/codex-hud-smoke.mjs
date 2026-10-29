import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let pty
try {
  const module = await import('node-pty')
  pty = module.default ?? module
} catch {
  throw new Error('node-pty is required for the Codex HUD terminal smoke')
}
const root = mkdtempSync(join(tmpdir(), 'ml-hud-smoke-'))
let terminal, closed, result, failure
let output = ''
const waitFor = async (predicate, label, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}: ${JSON.stringify(output)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
try {
  mkdirSync(join(root, '.model-ladder'))
  writeFileSync(join(root, '.model-ladder/live.json'), JSON.stringify({
    runId: 'hud-smoke',
    agents: [{ phase: 'worker', model: 'gpt-test', effort: 'low', startedAt: new Date().toISOString(), endedAt: null }],
  }))
  const hud = fileURLToPath(new URL('../../scripts/codex-hud.mjs', import.meta.url))
  const fake = fileURLToPath(new URL('../helpers/fake-terminal.mjs', import.meta.url))
  terminal = pty.spawn(process.execPath, [hud, '--cwd', root, '--', fake], {
    name: 'xterm-256color', cols: 60, rows: 8, cwd: root, env: { ...process.env, CODEX_BINARY: process.execPath, TERM: 'xterm-256color' },
  })
  closed = new Promise((resolve) => terminal.onExit((event) => { result = event; resolve(event) }))
  terminal.onData((data) => { output += data })
  await waitFor(() => /fake Codex ready/.test(output) && /gpt-test\/low \| RUNNING/.test(output), 'prompt and HUD')
  assert.match(output, /fake Codex ready/)
  assert.match(output, /model-ladder \| worker \| gpt-test\/low \| RUNNING/)
  assert.match(output, /\x1b\[8;1H/)
  terminal.resize(40, 6)
  await waitFor(() => /fake size 40x5/.test(output) && /\x1b\[6;1H/.test(output), 'child resize and HUD repaint')
  writeFileSync(join(root, '.model-ladder/live.json'), '{broken')
  await waitFor(() => /waiting/.test(output), 'corrupt live.json fallback')
  rmSync(join(root, '.model-ladder/live.json'))
  terminal.write('input-check')
  await waitFor(() => /input-check/.test(output), 'forwarded input with missing live.json')
  terminal.write('q')
  await waitFor(() => result, 'normal HUD exit')
  assert.equal(result.exitCode, 0)
  console.log('PASS: VERIFIED; the ConPTY smoke forwarded input, resized, and exited cleanly. Inspect a real Codex terminal separately.')
} catch (error) {
  failure = error
  throw error
} finally {
  try {
    if (terminal && !result) {
      terminal.kill()
      await waitFor(() => result, 'owned terminal teardown', 5000)
      await closed
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch (error) {
    if (!failure) throw error
    console.error(`HUD smoke cleanup: ${error.message}; fixture retained at ${root}`)
  }
}
process.stdout.write('', () => process.exit(0))
