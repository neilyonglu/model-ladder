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
