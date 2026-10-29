// Claude Code statusline script: saves the subscription rate limits to a file that model-ladder reads.
// Standalone on purpose (imports nothing from the plugin) so users can copy it to ~/.claude/.
//   default   reads statusline JSON on stdin, writes the usage file, prints e.g. "5h 42% · 7d 13%"
//   --percent [--root <repo>] prints the highest used percentage among unexpired windows, or "unknown";
//             with --root it reads the usage the band records in <repo>/.model-ladder/usage.json first
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_AGE = 15 * 60

export const usageFile = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'model-ladder-usage.json')

// The band writes the same shape here from Claude Code itself, so no statusline setup is needed.
export const projectUsageFile = (root) => join(root, '.model-ladder', 'usage.json')

const win = (w) => (typeof w?.used_percentage === 'number' ? { used_percentage: w.used_percentage, resets_at: w.resets_at ?? null } : null)

// Highest used percentage among unexpired windows; null = unknown (never blocks).
export function readClaudeUsage(file = usageFile(), now = Date.now() / 1000) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!(now - data.updatedAt <= MAX_AGE)) return null
    const live = [data.five_hour, data.seven_day].filter((w) => typeof w?.used_percentage === 'number' && w.resets_at > now).map((w) => w.used_percentage)
    return live.length ? Math.max(...live) : null
  } catch {
    return null
  }
}

function statusline(input) {
  let data
  try { data = JSON.parse(input) } catch { return '' }
  const five = win(data?.rate_limits?.five_hour)
  const seven = win(data?.rate_limits?.seven_day)
  if (!five && !seven) return ''
  try {
    const file = usageFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ five_hour: five, seven_day: seven, updatedAt: Math.floor(Date.now() / 1000) }))
  } catch {}
  return [five && `5h ${Math.round(five.used_percentage)}%`, seven && `7d ${Math.round(seven.used_percentage)}%`].filter(Boolean).join(' · ')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--percent')) {
    const at = process.argv.indexOf('--root')
    const root = at > 0 ? process.argv[at + 1] : null
    const percent = (root ? readClaudeUsage(projectUsageFile(root)) : null) ?? readClaudeUsage()
    console.log(percent === null ? 'unknown' : percent)
  } else {
    let input = ''
    try { input = readFileSync(0, 'utf8') } catch {}
    console.log(statusline(input))
  }
}
