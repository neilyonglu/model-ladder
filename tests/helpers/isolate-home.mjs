// Imported first by every unit test file (tests/unit/config.test.mjs checks): no test reads or writes the real
// ~/.claude or ~/.codex. The user-level settings file, the Claude config dir and the Codex home all point into a
// temp dir that is removed when the test process exits. HOME itself stays, so git keeps its own global config.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'ml-home-'))
let count = 0

// A new, absent user settings file for the current process and every child it starts after.
export function freshUserConfig() {
  process.env.MODEL_LADDER_USER_CONFIG = join(base, `user-${++count}`, 'model-ladder.json')
  return process.env.MODEL_LADDER_USER_CONFIG
}

freshUserConfig()
process.env.CLAUDE_CONFIG_DIR = join(base, 'claude')
process.env.CODEX_HOME = join(base, 'codex')
// The machine-wide registry of running ladder runs: a usage-limit test must never stop a real run on this machine.
process.env.MODEL_LADDER_ACTIVE_DIR = join(base, 'active')
process.on('exit', () => rmSync(base, { recursive: true, force: true }))
