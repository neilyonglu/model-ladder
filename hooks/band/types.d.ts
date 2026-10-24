export type Row = {
  role: 'worker' | 'test-writer' | 'router' | 'verifier'
  redo: boolean
  id: string
  cell: string
  task: string
  status: 'running' | 'done'
  ms: number | null
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-ladder': { runId: string | null; rows: Row[]; isFolded: boolean }
  }
}
