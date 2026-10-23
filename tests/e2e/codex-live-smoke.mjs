// Offline terminal demo: real runner/worktrees, fake Codex, real watch command.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLadder } from '../../scripts/codex-run.mjs'

const root = mkdtempSync(join(tmpdir(), 'ml-live-demo-'))
const terminal = process.argv.includes('--terminal')
const write = (file, text) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), text) }
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
let watcher, closed
try {
  git('init', '-q')
  git('config', 'user.name', 'test')
  git('config', 'user.email', 'test@example.test')
  write('.gitignore', '.model-ladder/\ncodex-home/\n')
  write('greeting.mjs', 'export default "Wellcome"\n')
  write('scenario.json', JSON.stringify({ delay: 2300 }))
  write('.codex/model-ladder.json', JSON.stringify({
    router: { model: 'cheap', effort: 'low' }, verifier: { model: 'cheap', effort: 'low' },
    tiers: [{ model: 'cheap', efforts: ['low'], maxEffortJump: 1 }],
    verify: 'node --check greeting.mjs',
  }))
  write('codex-home/sessions/demo.jsonl', JSON.stringify({ payload: { rate_limits: {
    primary: { used_percent: 15, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
    secondary: { used_percent: 44, window_minutes: 10080, resets_at: Date.now() / 1000 + 3600 },
  } } }) + '\n')
  // Fixture commit only, inside a disposable /tmp repository.
  git('add', '.')
  git('commit', '-qm', 'fixture')
  process.env.CODEX_HOME = join(root, 'codex-home')
  let output = '', errors = ''
  watcher = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/watch.mjs', import.meta.url)), '--cwd', root], { stdio: ['ignore', terminal ? 'inherit' : 'pipe', 'pipe'] })
  closed = new Promise((resolve, reject) => { watcher.once('error', reject); watcher.once('close', resolve) })
  watcher.stdout?.setEncoding('utf8').on('data', (text) => { output += text; process.stdout.write(text) })
  watcher.stderr.setEncoding('utf8').on('data', (text) => { errors += text })
  const result = await runLadder({ task: '修正 greeting 拼字並驗證結果' }, {
    cwd: root,
    executable: { command: process.execPath, prefixArgs: [fileURLToPath(new URL('../helpers/fake-codex.mjs', import.meta.url)), root] },
    onProgress: (text) => { if (!terminal && text.startsWith('▴')) process.stderr.write(`RUNNER SNAPSHOT\n${text}\n`) },
  })
  assert.equal(result.status, 'VERIFIED', JSON.stringify(result))
  const live = JSON.parse(readFileSync(join(root, '.model-ladder/live.json')))
  const deadline = Math.max(...live.agents.map((a) => Date.parse(a.endedAt))) + 11500
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
  watcher.kill('SIGINT')
  assert.equal(await closed, 0, errors)
  assert.equal(errors, '')
  if (!terminal) {
    const frames = output.split('▴').slice(1)
    assert.ok(frames.some((frame) => /worker:/.test(frame) && /  1s\s+worker:/.test(frame)))
    assert.ok(frames.some((frame) => /✓ 2s/.test(frame)))
    assert.match(frames.at(-1), /5h 15% · 7d 44% · idle/)
    assert.doesNotMatch(frames.at(-1), /cheap\/low|node\//)
  }
  console.log('PASS: VERIFIED; running seconds updated, completed time froze, all completed rows disappeared after 10s.')
} finally {
  if (watcher?.exitCode === null) { watcher.kill('SIGTERM'); await closed }
  rmSync(root, { recursive: true, force: true })
}
