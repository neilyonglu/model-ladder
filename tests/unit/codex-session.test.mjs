import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionText } from '../../hooks/codex-session.mjs'

test('session reuses an active HUD, preserves panel fallback and skips internal roles', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ml-session-'))
  try {
    assert.match(sessionText({ cwd }, {}), /codex-hud\.mjs/)
    assert.match(sessionText({ cwd }, {}), /cannot attach/)
    assert.match(sessionText({ cwd }, {}), /open_in_codex/)
    assert.match(sessionText({ cwd }, {}), /persistent PTY/)
    assert.match(sessionText({ cwd }, {}), /model-ladder skill/)
    assert.match(sessionText({ cwd }, { MODEL_LADDER_AUTORUN: '0' }), /model-ladder panel/)
    assert.doesNotMatch(sessionText({ cwd }, { MODEL_LADDER_AUTORUN: '0' }), /installed and on/)
    assert.equal(sessionText({ cwd }, { MODEL_LADDER_ROLE: 'worker' }), '')
    const hud = sessionText({ cwd }, { MODEL_LADDER_HUD: '1', MODEL_LADDER_BAND: '0' })
    assert.match(hud, /HUD is already running/)
    assert.doesNotMatch(hud, /open_in_codex/)
    mkdirSync(join(cwd, '.codex'))
    writeFileSync(join(cwd, '.codex/model-ladder.json'), JSON.stringify({ autoRun: false, band: false }))
    assert.equal(sessionText({ cwd }, {}), '')
    const hooks = JSON.parse(readFileSync(new URL('../../hooks/codex-hooks.json', import.meta.url)))
    assert.match(hooks.hooks.SessionStart[0].matcher, /fork/)
    assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /PLUGIN_ROOT.*codex-session/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
