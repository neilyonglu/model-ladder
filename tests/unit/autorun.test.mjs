import test from 'node:test'
import assert from 'node:assert/strict'
import { autorunText } from '../../hooks/autorun.mjs'

test('autorun: on by default, names the runtime\'s way to run the ladder', () => {
  assert.match(autorunText({}), /\/model-ladder:run <task>/)
  assert.match(autorunText({ PLUGIN_DATA: '/data' }), /model-ladder skill/)
  assert.match(autorunText({ CLAUDE_PLUGIN_OPTION_AUTORUN: 'true' }), /installed and on/)
})

test('autorun: the plugin option or MODEL_LADDER_AUTORUN turns it off', () => {
  for (const value of ['false', '0', 'off', ' FALSE ']) assert.equal(autorunText({ CLAUDE_PLUGIN_OPTION_AUTORUN: value }), '')
  assert.equal(autorunText({ MODEL_LADDER_AUTORUN: '0' }), '')
  assert.equal(autorunText({ PLUGIN_DATA: '/data', MODEL_LADDER_AUTORUN: 'off' }), '')
})
