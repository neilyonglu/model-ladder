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
}

declare module 'claude-code' {
  interface PluginState {
    'model-ladder': { rows: Row[]; isFolded: boolean; areSkillsFolded: boolean; contextText: string }
  }
}
