#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { artifactDir } from '../../../scripts/common.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const mode = process.argv[2] ?? 'handoff'
if (!['doctor', 'handoff', 'panel'].includes(mode)) {
  console.error('Usage: node .agents/skills/verify/verify.mjs [doctor|handoff|panel]')
  process.exit(2)
}
const evidence = join(artifactDir(root), 'verification', randomUUID())
mkdirSync(evidence, { recursive: true })
console.log(`Evidence: ${evidence}`)
const result = { cwd: root, mode, startedAt: new Date().toISOString(), passed: false, commands: [] }
const save = () => writeFileSync(join(evidence, 'result.json'), JSON.stringify(result, null, 2) + '\n')
function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 })
  const stem = String(result.commands.length + 1).padStart(2, '0')
  writeFileSync(join(evidence, `${stem}.stdout.txt`), child.stdout ?? '')
  writeFileSync(join(evidence, `${stem}.stderr.txt`), child.stderr ?? '')
  result.commands.push({ command, args, exitCode: child.status, signal: child.signal, error: child.error?.message, stdout: `${stem}.stdout.txt`, stderr: `${stem}.stderr.txt` })
  save()
  console.log(`${child.status === 0 ? 'PASS' : 'FAIL'} ${command} ${args.join(' ')}`)
  if (child.error || child.status !== 0) throw new Error(child.error?.message ?? `Command exited ${child.status}; see ${evidence}`)
  return child.stdout
}
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required')
  result.revision = run('git', ['rev-parse', 'HEAD']).trim()
  if (mode === 'doctor') {
    run('git', ['--version'])
    run(process.execPath, ['scripts/codex-run.mjs', '--help'])
    run(process.execPath, ['scripts/watch.mjs', '--help'])
    run(process.execPath, ['scripts/sync-rules.mjs', '--check'])
    run(process.execPath, ['--test', '--test-name-pattern=same package identity/version', 'tests/unit/codex.test.mjs'])
  }
  if (mode === 'handoff') {
    const fixture = join(evidence, 'scratch')
    mkdirSync(join(fixture, '.model-ladder'), { recursive: true })
    const live = { runId: 'codex-verification-fixture', task: 'Verify handoff persistence', input: { task: 'Verify handoff persistence' }, agents: [{ phase: 'worker', model: 'fixture', effort: 'low', endedAt: null }] }
    try {
      for (const state of ['active', 'stopped']) {
        if (state === 'stopped') {
          live.agents = []
          live.result = { status: 'STOPPED', errorCode: 'USAGE_LIMIT', runId: live.runId, checkpointPath: join(fixture, 'checkpoint.json'), worktreePath: join(fixture, 'draft'), attempts: [] }
        }
        writeFileSync(join(fixture, '.model-ladder/live.json'), JSON.stringify(live))
        run(process.execPath, ['scripts/watch.mjs', '--cwd', fixture, '--handoff'])
        const handoff = readFileSync(join(fixture, '.model-ladder/HANDOFF.md'), 'utf8')
        writeFileSync(join(evidence, `${state}-HANDOFF.md`), handoff)
        assert.ok(handoff.includes(live.task))
        assert.match(handoff, state === 'active' ? /still active/ : /quota reset/)
        const resume = JSON.parse(handoff.match(/```json\s*([\s\S]*?)```/)[1])
        assert.equal(resume.task, live.task)
        if (state === 'stopped') assert.equal(resume.resumeRun, live.runId)
      }
      result.handoffChecks = ['active task and warning', 'quota stop and exact resume JSON']
    } finally { rmSync(fixture, { recursive: true, force: true }) }
    assert.equal(readFileSync(join(evidence, 'active-HANDOFF.md'), 'utf8').includes(live.task), true)
    assert.equal(readFileSync(join(evidence, 'stopped-HANDOFF.md'), 'utf8').includes(live.runId), true)
  }
  if (mode === 'panel') {
    const output = run(process.execPath, ['tests/e2e/codex-live-smoke.mjs'])
    if (!output.includes('PASS: VERIFIED')) throw new Error('Terminal smoke did not report VERIFIED')
  }
  result.passed = true
} catch (error) {
  result.error = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  result.endedAt = new Date().toISOString()
  save()
}
