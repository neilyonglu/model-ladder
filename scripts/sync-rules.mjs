import { readFileSync, writeFileSync } from 'node:fs'
const workflow = new URL('../workflows/ladder.js', import.meta.url)
const target = new URL('./ladder-rules.mjs', import.meta.url)
const pure = readFileSync(workflow, 'utf8').split('// <pure>')[1].split('// </pure>')[0]
const generated = `${pure}\nexport { legalMoves, defaultMove, pickMove, isCell, protectedPatterns, ARTIFACTS }\n`
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) throw new Error('Run node scripts/sync-rules.mjs')
} else writeFileSync(target, generated)