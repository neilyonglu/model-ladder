import '../helpers/isolate-home.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { addRow, finishRow, removeRow, anyRunning, runCount, isRedo } from '../../hooks/band/rows.mjs'

const row = (id, run) => ({ id, run, role: 'worker', redo: false, cell: 'x', task: 't', status: 'running', ms: null, startedAt: 0 })

test('rows of two interleaved runs are all kept', () => {
  let l = []
  for (const [id, run] of [['a1', 'A'], ['b1', 'B'], ['a2', 'A'], ['b2', 'B']]) l = addRow(l, row(id, run))
  assert.deepEqual(l.map((r) => r.id), ['a1', 'b1', 'a2', 'b2'])
  assert.equal(runCount(l), 2)
})

test('each row finishes on its own and is removed on its own', () => {
  let l = addRow(addRow([], row('a1', 'A')), row('b1', 'B'))
  l = finishRow(l, 'a1', 500)
  assert.equal(l[0].status, 'done')
  assert.equal(l[0].ms, 500)
  assert.equal(l[1].status, 'running')
  assert.equal(anyRunning(l), true)
  l = finishRow(l, 'b1', 7)
  assert.equal(anyRunning(l), false)
  l = removeRow(l, 'a1')
  assert.deepEqual(l.map((r) => r.id), ['b1'])
})

test('redo only looks at the same run verifier', () => {
  const verified = new Set(['A'])
  assert.equal(isRedo(verified, 'A', true), true)
  assert.equal(isRedo(verified, 'B', true), false)
  assert.equal(isRedo(verified, 'A', false), false)
})
