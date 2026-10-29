// Pure row-list updates for the band. Rows from several workflow runs live in one list, each tagged with its run id.

export const addRow = (list, row) => [...list, row]

export const finishRow = (list, id, ms) => list.map((r) => (r.id === id ? { ...r, status: 'done', ms } : r))

export const removeRow = (list, id) => list.filter((r) => r.id !== id)

export const anyRunning = (list) => list.some((r) => r.status === 'running')

export const runCount = (list) => new Set(list.map((r) => r.run)).size

// A worker spawned after its own run's verifier is a redispatch; other runs' verifiers do not count.
export const isRedo = (verified, run, isWorker) => isWorker && verified.has(run)
