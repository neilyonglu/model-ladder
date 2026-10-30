export type Row = {
  role: 'worker' | 'test-writer' | 'router' | 'verifier'
  redo: boolean
  run: string
  id: string
  cell: string
  task: string
  status: 'running' | 'done'
  ms: number | null
  startedAt: number
  // The run's expected total duration from its forecast, or null when unknown.
  expectedMs: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-ladder': { rows: Row[]; isFolded: boolean; areSkillsFolded: boolean; contextText: string }
  }
}
