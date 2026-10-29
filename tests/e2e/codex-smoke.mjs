import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS, runLadder } from '../../scripts/codex-run.mjs'

const root = mkdtempSync(join(tmpdir(), 'model-ladder-live-'))
const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
const model = process.env.MODEL_LADDER_SMOKE_MODEL ?? 'gpt-6-luna'
const effort = process.env.MODEL_LADDER_SMOKE_EFFORT ?? 'low'
git('init', '-q')
git('config', 'user.name', 'model-ladder smoke')
git('config', 'user.email', 'smoke@example.test')
mkdirSync(join(root, '.codex'))
writeFileSync(join(root, '.gitignore'), '.model-ladder/\n')
writeFileSync(join(root, 'greeting.mjs'), 'export default "Wellcome"\n')
writeFileSync(join(root, 'greeting.test.mjs'), 'import assert from "node:assert/strict"\nimport greeting from "./greeting.mjs"\nassert.equal(greeting, "Welcome")\n')
writeFileSync(join(root, '.codex/model-ladder.json'), JSON.stringify({ router: DEFAULTS.router, verifier: DEFAULTS.verifier, tiers: [{ model, efforts: [effort], maxEffortJump: 1 }], maxAttempts: 1, verify: 'node --test greeting.test.mjs' }))
git('add', '-A')
git('commit', '-qm', 'smoke fixture')
const result = await runLadder({ task: 'Fix the typo in greeting.mjs so the existing greeting test passes. Do not modify tests.' }, { cwd: root, onProgress: console.error })
console.log(JSON.stringify({ fixture: root, ...result }, null, 2))
if (result.status === 'VERIFIED') {
  assert.match(readFileSync(join(root, 'greeting.mjs'), 'utf8'), /Welcome/)
  assert.equal(git('diff', '--cached').length, 0)
  rmSync(root, { recursive: true, force: true })
} else process.exitCode = 1
