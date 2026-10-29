import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatContext } from '../../hooks/band/context.mjs'

test('tokens and window use k and M abbreviations', () => {
  assert.equal(formatContext({ tokens: 35000, window: 1000000 }), 'ctx 35k/1M (3.5%)')
  assert.equal(formatContext({ tokens: 120400, window: 200000 }), 'ctx 120k/200k (60.2%)')
  assert.equal(formatContext({ tokens: 1500000, window: 2000000 }), 'ctx 1.5M/2M (75%)')
  assert.equal(formatContext({ tokens: 800, window: 200000 }), 'ctx 800/200k (0.4%)')
  assert.equal(formatContext({ tokens: 0, window: 200000 }), 'ctx 0/200k (0%)')
})

test('percent shows one decimal and drops a trailing .0', () => {
  assert.equal(formatContext({ tokens: 287000, window: 1000000 }), 'ctx 287k/1M (28.7%)')
  assert.equal(formatContext({ tokens: 500000, window: 1000000 }), 'ctx 500k/1M (50%)')
  assert.equal(formatContext({ tokens: 0, window: 1000000 }), 'ctx 0/1M (0%)')
  assert.equal(formatContext({ tokens: 1000000, window: 1000000 }), 'ctx 1M/1M (100%)')
})

test('percent rounds to one decimal', () => {
  assert.equal(formatContext({ tokens: 333333, window: 1000000 }), 'ctx 333k/1M (33.3%)')
  assert.equal(formatContext({ tokens: 666667, window: 1000000 }), 'ctx 667k/1M (66.7%)')
  assert.equal(formatContext({ tokens: 12500, window: 1000000 }), 'ctx 13k/1M (1.3%)')
})

test('missing tokens shows only the window', () => {
  assert.equal(formatContext({ window: 1000000 }), 'ctx 1M')
  assert.equal(formatContext({ tokens: undefined, window: 200000, percent: 10 }), 'ctx 200k')
})

test('missing or invalid window shows nothing', () => {
  assert.equal(formatContext(undefined), '')
  assert.equal(formatContext(null), '')
  assert.equal(formatContext({ tokens: 5000 }), '')
  assert.equal(formatContext({ tokens: 5000, window: 0 }), '')
})
