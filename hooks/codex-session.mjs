import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { autorunText } from './autorun.mjs'

export function sessionText(input = {}, env = process.env) {
  if (env.MODEL_LADDER_ROLE) return ''
  const cwd = input.cwd ?? process.cwd()
  let config = {}
  const path = join(cwd, '.codex', 'model-ladder.json')
  if (existsSync(path)) config = JSON.parse(readFileSync(path, 'utf8'))
  const parts = []
  if (config.band !== false && !['0', 'false', 'off', 'no'].includes(String(env.MODEL_LADDER_BAND ?? '').toLowerCase())) {
    const watcher = fileURLToPath(new URL('../scripts/watch.mjs', import.meta.url))
    parts.push(`model-ladder panel: before the next top-level task, ensure one live panel for this repository. Reuse the existing watcher terminal in this chat on resume/compact. Otherwise start Node with script ${JSON.stringify(watcher)} and arguments --cwd ${JSON.stringify(cwd)} in a persistent PTY terminal, then show that terminal using open_in_codex when available. Keep the watcher running between tasks; do not wait for it to exit. If this surface cannot show a terminal panel, use the runner's progress output and explain that limitation. Panel setup is an internal ladder step; never route it through the ladder. The panel is independent of autoRun.`)
  }
  if (config.autoRun !== false) parts.push(autorunText({ ...env, PLUGIN_DATA: env.PLUGIN_DATA ?? 'codex' }))
  return parts.filter(Boolean).join('\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
    const text = sessionText(input)
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }) + '\n')
  } catch (error) { process.stderr.write(`model-ladder session setup: ${error.message}\n`); process.exitCode = 1 }
}
