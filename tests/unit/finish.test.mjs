import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/finish.mjs', import.meta.url))
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })

// A repo with a run marker, a state file and a leftover worktree, as preflight and a worker would leave it.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ml-finish-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(dir, '.claude', 'worktrees', 'w')
  git(dir, 'worktree', 'add', '-q', wt, '-b', 'worktree-w')
  const run = join(dir, '.model-ladder')
  mkdirSync(run)
  writeFileSync(join(run, 'run.json'), '{}')
  writeFileSync(join(run, 'state.json'), '{"before":[],"config":{}}')
  return { dir, wt, run }
}

const finish = (dir, input) => spawnSync('node', [script], {
  cwd: dir, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, MODEL_LADDER_NO_UPDATE_CHECK: '1' },
})

const untouched = ({ wt, run }) => {
  assert.ok(existsSync(wt), 'worktree kept')
  assert.ok(existsSync(join(run, 'run.json')), 'run marker kept')
  assert.ok(existsSync(join(run, 'state.json')), 'state.json kept')
  assert.ok(!existsSync(join(run, 'history.jsonl')), 'no history written')
}

test('a whole workflow-output wrapper is rejected and nothing is cleaned', () => {
  const s = setup()
  const wrapper = { summary: 's', agentCount: 3, logs: [], result: { status: 'VERIFIED', winner: { worktreePath: s.wt, filesChanged: ['a'] } } }
  const r = finish(s.dir, { task: 't', result: wrapper })
  assert.notEqual(r.status, 0)
  assert.match(r.stdout, /result\.status missing — pass the workflow's result field, not the whole output/)
  untouched(s)
})

test('unknown status and VERIFIED without a winner are rejected', () => {
  const s = setup()
  const unknown = finish(s.dir, { task: 't', result: { status: 'BOGUS' } })
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stdout, /BOGUS/)
  const noWinner = finish(s.dir, { task: 't', result: { status: 'VERIFIED' } })
  assert.notEqual(noWinner.status, 0)
  assert.match(noWinner.stdout, /winner/)
  untouched(s)
})

test('aborted without a result is still accepted and cleans up', () => {
  const s = setup()
  const r = finish(s.dir, { task: 't', aborted: 'no' })
  assert.equal(r.status, 0)
  assert.ok(!existsSync(join(s.run, 'run.json')))
})
