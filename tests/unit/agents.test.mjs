import '../helpers/isolate-home.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')

for (const name of ['worker', 'test-writer', 'verifier']) {
  test(`agent ${name} has no tools allowlist and excludes Workflow and Agent`, () => {
    const text = read(`agents/${name}.md`)
    const front = text.split('\n---\n')[0]
    assert.doesNotMatch(front, /^tools:/m)
    assert.match(front, /^disallowedTools: .*\bWorkflow\b.*\bAgent\b.*$/m)
    assert.match(text, /never spawn another agent/)
    assert.match(text, /model-ladder skill, workflows or runners/)
  })
}

test('verifier body forbids file modification', () => {
  assert.match(read('agents/verifier.md'), /never use Edit, Write/)
})

test('skill instruction text covers plugins, MCP tools and blocker listing', () => {
  for (const file of ['workflows/ladder.js', 'scripts/codex-run.mjs']) {
    const text = read(file)
    for (const word of ['plugins', 'slash commands', 'MCP tools', 'MCP server name', 'list the available capabilities you checked']) {
      assert.ok(text.includes(word), `${file} missing ${word}`)
    }
  }
})
