import '../helpers/isolate-home.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { roundSpan } from '../../hooks/band/remaining.mjs'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H
const ms = (h = 0, m = 0, s = 0) => h * H + m * M + s * S

test('rounds to the nearest value in the largest unit', () => {
  assert.equal(roundSpan(ms(4, 34)), '5h')
  assert.equal(roundSpan(ms(0, 3, 20)), '3m')
  assert.equal(roundSpan(ms(4, 29)), '4h')
  assert.equal(roundSpan(ms(2 * 24 + 13)), '3d')
  assert.equal(roundSpan(ms(0, 0, 45)), '45s')
})

test('carries up to the next unit instead of printing 60m, 24h or 60s', () => {
  assert.equal(roundSpan(ms(0, 59, 40)), '1h')
  assert.equal(roundSpan(ms(23, 40)), '1d')
  assert.equal(roundSpan(59.6 * S), '1m')
})

test('rounds at the unit boundaries', () => {
  assert.equal(roundSpan(1), '0s')
  assert.equal(roundSpan(M - 1), '1m')
  assert.equal(roundSpan(M + 29 * S), '1m')
  assert.equal(roundSpan(M + 30 * S), '2m')
  assert.equal(roundSpan(H - 30 * S), '1h')
  assert.equal(roundSpan(H - 31 * S), '59m')
  assert.equal(roundSpan(D - 30 * M), '1d')
  assert.equal(roundSpan(D - 31 * M), '23h')
})
