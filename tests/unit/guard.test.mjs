import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ALWAYS_PROTECTED, TEST_PATTERNS, check, isProtected } from '../../hooks/guard.mjs'

test('test patterns match test files at any depth', () => {
  for (const p of ['tests/a.py', 'pkg/tests/sub/a.py', 'test_x.py', 'src/x_test.py', 'web/a.test.ts', 'a.spec.js', 'x/__tests__/a.js', 'mod/src/test/A.java']) {
    assert.ok(isProtected(p, TEST_PATTERNS), p)
  }
})

test('test patterns leave source files alone', () => {
  for (const p of ['src/parser.py', 'testing.py', 'contest/a.py', 'src/latest.py']) {
    assert.ok(!isProtected(p, TEST_PATTERNS), p)
  }
})

test('backslash paths match', () => {
  assert.ok(isProtected('pkg\\tests\\a.py', TEST_PATTERNS))
})

const repo = mkdtempSync(join(tmpdir(), 'ml-guard-'))
execFileSync('git', ['init', '-q', repo])
mkdirSync(join(repo, '.model-ladder'), { recursive: true })
const marker = join(repo, '.model-ladder', 'run.json')
const writeMarker = (extra = []) =>
  writeFileSync(marker, JSON.stringify({ protected: [...ALWAYS_PROTECTED, ...extra], tests: TEST_PATTERNS }))
after(() => rmSync(repo, { recursive: true, force: true }))

const input = (overrides) => ({
  agent_type: 'model-ladder:worker',
  cwd: repo,
  tool_input: { file_path: join(repo, 'tests', 'test_a.py') },
  ...overrides,
})

test('finds the main repo marker from inside a linked worktree', () => {
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
  const wt = join(repo, '.claude', 'worktrees', 'wf_1')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt])
  writeMarker()
  assert.match(check(input({ cwd: wt, tool_input: { file_path: join(wt, 'tests', 'a.py') } })), /tests\/a\.py is protected/)
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt])
})

test('no marker means no run, so nothing is blocked', () => {
  rmSync(marker, { force: true })
  assert.equal(check(input()), null)
})

test('the worker may not edit tests during a run', () => {
  writeMarker()
  assert.match(check(input()), /tests\/test_a\.py is protected/)
})

test('the test-writer may edit tests but not the ladder config or project patterns', () => {
  writeMarker(['migrations/**'])
  const writer = (file) => check(input({ agent_type: 'model-ladder:test-writer', tool_input: { file_path: join(repo, file) } }))
  assert.equal(writer('tests/test_a.py'), null)
  assert.match(writer('.claude/model-ladder.json'), /protected/)
  assert.match(writer('migrations/v1.sql'), /protected/)
})

test('other agents and the main session are never blocked', () => {
  writeMarker()
  assert.equal(check(input({ agent_type: undefined })), null)
  assert.equal(check(input({ agent_type: 'general-purpose' })), null)
})

// Concurrent runs: each holds .model-ladder/runs/<runId>.json, and a worker obeys all of them.
const runLock = (runId, value) => {
  mkdirSync(join(repo, '.model-ladder', 'runs'), { recursive: true })
  writeFileSync(join(repo, '.model-ladder', 'runs', `${runId}.json`), typeof value === 'string' ? value : JSON.stringify({ runId, runtime: 'claude', pid: null, scope: null, ...value }))
}
const clearRuns = () => rmSync(join(repo, '.model-ladder', 'runs'), { recursive: true, force: true })

test('with several runs active, the worker obeys the protection of every run', () => {
  rmSync(marker, { force: true })
  runLock('claude-a', { protected: [...ALWAYS_PROTECTED, 'migrations/**'], tests: TEST_PATTERNS })
  runLock('codex-b', { runtime: 'codex', pid: process.pid, protected: ['.codex/model-ladder.json', 'docs/**'], tests: TEST_PATTERNS })
  const worker = (file) => check(input({ tool_input: { file_path: join(repo, file) } }))
  assert.match(worker('tests/test_a.py'), /protected/)
  assert.match(worker('migrations/v1.sql'), /protected/)
  assert.match(worker('docs/guide.md'), /protected/)
  assert.match(worker('.codex/model-ladder.json'), /protected/)
  assert.equal(worker('src/app.py'), null)
  const writer = (file) => check(input({ agent_type: 'model-ladder:test-writer', tool_input: { file_path: join(repo, file) } }))
  assert.equal(writer('tests/test_a.py'), null)
  assert.match(writer('docs/guide.md'), /protected/)
  clearRuns()
})

test('an unreadable lock does not switch off the other runs, and a legacy run.json still counts', () => {
  runLock('claude-a', { protected: ['migrations/**'], tests: TEST_PATTERNS })
  runLock('claude-broken', '{ not json')
  writeMarker(['legacy/**'])
  const worker = (file) => check(input({ tool_input: { file_path: join(repo, file) } }))
  assert.match(worker('migrations/v1.sql'), /protected/)
  assert.match(worker('legacy/x.py'), /protected/)
  assert.match(worker('tests/test_a.py'), /protected/)
  clearRuns()
  rmSync(marker, { force: true })
  assert.equal(worker('tests/test_a.py'), null, 'no run, no protection')
})
