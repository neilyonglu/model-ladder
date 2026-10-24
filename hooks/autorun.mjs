// SessionStart hook: tells the session that model-ladder is the default for every top-level task,
// so a new machine needs no CLAUDE.md or AGENTS.md edit. Prints nothing when turned off.
// Claude Code: plugin option autoRun (CLAUDE_PLUGIN_OPTION_AUTORUN). Both runtimes: MODEL_LADDER_AUTORUN=0.
import { pathToFileURL } from 'node:url'

const OFF = ['false', '0', 'no', 'off']
const off = (value) => OFF.includes(String(value ?? '').trim().toLowerCase())

const SCOPE = `Every top-level task, of any kind (code, research, analysis, docs, settings), goes through model-ladder first, unless the user says to skip it ("no ladder", "do it directly"). The ladder's router decides whether this session does it directly (DIRECT) or agents do it.
Not through the ladder: the ladder's own steps (preflight, finish, answering its questions) and anything inside a ladder role (router, worker, test-writer, verifier); the ladder is never started again there.
Outside a git repository the ladder cannot run: tell the user it needs a git repository, then do the task directly in place.
When the ladder is blocked for any other reason, tell the user where it is stuck; do not quietly do the task another way.`

export function autorunText(env = process.env) {
  if (off(env.CLAUDE_PLUGIN_OPTION_AUTORUN) || off(env.MODEL_LADDER_AUTORUN ?? 'on')) return ''
  // Codex sets PLUGIN_DATA for plugin hooks; Claude Code does not.
  const how = env.PLUGIN_DATA
    ? 'In Codex the ladder runs through the installed model-ladder skill: read its SKILL.md and run its packaged runner.'
    : 'In Claude Code the ladder runs as /model-ladder:run <task>.'
  return `model-ladder is installed and on.\n${SCOPE}\n${how}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(autorunText())
