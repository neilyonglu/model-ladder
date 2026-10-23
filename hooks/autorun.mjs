// SessionStart hook: tells the session that model-ladder is the default for coding tasks,
// so a new machine needs no CLAUDE.md or AGENTS.md edit. Prints nothing when turned off.
// Claude Code: plugin option autoRun (CLAUDE_PLUGIN_OPTION_AUTORUN). Both runtimes: MODEL_LADDER_AUTORUN=0.
import { pathToFileURL } from 'node:url'

const OFF = ['false', '0', 'no', 'off']
const off = (value) => OFF.includes(String(value ?? '').trim().toLowerCase())

const SCOPE = `Top-level coding tasks in a git repository (implement, fix a bug, refactor, write tests) go through model-ladder by default, unless the user says to skip it ("no ladder", "do it directly").
Handled directly, without the ladder: conversation and questions, status checks, git operations, editing settings or docs, and model-ladder's own setup.
Inside a model-ladder role (router, worker, test-writer, verifier) the ladder is never started again.
When the ladder is unavailable or blocked, the user is told where it is stuck; the task is not quietly done another way.`

export function autorunText(env = process.env) {
  if (off(env.CLAUDE_PLUGIN_OPTION_AUTORUN) || off(env.MODEL_LADDER_AUTORUN ?? 'on')) return ''
  // Codex sets PLUGIN_DATA for plugin hooks; Claude Code does not.
  const how = env.PLUGIN_DATA
    ? 'In Codex the ladder runs through the installed model-ladder skill: read its SKILL.md and run its packaged runner.'
    : 'In Claude Code the ladder runs as /model-ladder:run <task>.'
  return `model-ladder is installed and on.\n${SCOPE}\n${how}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(autorunText())
