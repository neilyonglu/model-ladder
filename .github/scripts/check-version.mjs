// Fails when plugin code changed since the last release tag but plugin.json's version did not.
// Claude Code decides "new version" by that field alone: a push without a bump reaches no one.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { compareVersions } from '../../scripts/update-check.mjs'

const PLUGIN_PATHS = ['.claude-plugin', 'skills', 'agents', 'hooks', 'scripts', 'workflows']
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

let tag
try {
  tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*')
} catch {
  console.log('No release tag yet; nothing to compare.')
  process.exit(0)
}

const version = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version
const changed = git('diff', '--name-only', tag, 'HEAD', '--', ...PLUGIN_PATHS).split('\n').filter(Boolean)

if (changed.length && compareVersions(version, tag.slice(1)) <= 0) {
  console.error(`Plugin files changed since ${tag}, but .claude-plugin/plugin.json is still ${version}:`)
  for (const file of changed) console.error(`  ${file}`)
  console.error('Bump "version" (and add a CHANGELOG entry), or users will never receive this change.')
  process.exit(1)
}
console.log(changed.length ? `Plugin changed since ${tag}; version ${version} is ahead. OK.` : `No plugin changes since ${tag}. OK.`)
