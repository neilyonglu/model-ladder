import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Row } from './types'

const runId = atom({ plugin: 'model-ladder', key: 'runId' } as const, null)
const rows = atom({ plugin: 'model-ladder', key: 'rows' } as const, [])
const isFolded = atom({ plugin: 'model-ladder', key: 'isFolded' } as const, false)


type Config = { usageGuard?: { enabled?: boolean; threshold?: number }; [key: string]: unknown }

const configPath = async ($: EngineInterface) => `${await $.session.cwd()}/.claude/model-ladder.json`
async function readConfig($: EngineInterface): Promise<Config> {
  try { return JSON.parse(await $.fs.read(await configPath($))) } catch { return {} }
}
async function editConfig($: EngineInterface, edit: (c: Config) => Config) {
  await $.fs.write(await configPath($), `${JSON.stringify(edit(await readConfig($)), null, 2)}\n`)
  $.ui.invalidate('ui.render')
}

// The ladder's prompts carry the user's task on the line after a TASK header.
const taskOf = (prompt: string, fallback: string) => (prompt.match(/TASK[^\n]*\n\s*([^\n]+)/)?.[1] ?? fallback).trim()
// claude-haiku-5-5 -> haiku-5.5; an alias such as haiku stays as is.
const modelName = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2')
const seconds = (ms: number) => (ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`)
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
const DONE_MS = 10000
const LONG_MS = 10 * 60 * 1000
// Cuts text to a width in cells, counting CJK and other wide characters as two.
const clip = (text: string, cols: number) => {
  let out = '', used = 0
  for (const ch of text) {
    const w = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
    if (used + w > cols - 1) return `${out}…`
    out += ch; used += w
  }
  return out
}
const WINDOW: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export const register: Register = on => {
  // Redraws once a second while an agent runs, so its elapsed time moves.
  let tick: Timer | null = null
  // What the person typed in the threshold field, until they press set.
  let draft: string | null = null
  // Agents already told about; a long run is only reported, never stopped.
  const warned = new Set<string>()

  // A reload drops its pending removals, so finished rows left from before it go now.
  on('session.start', async ($, e, next) => {
    await update($, rows, (l) => l.filter((r) => r.status === 'running'))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!e.workflow || !e.subagentType.startsWith('model-ladder:') || !result.agentId) return result
    if ((await read($, runId)) !== e.workflow.runId) {
      await update($, runId, () => e.workflow!.runId)
      await update($, rows, () => [])
    }
    const effort = e.description.match(/\S+\/(\S+)/)?.[1]
    const row: Row = {
      id: result.agentId,
      cell: `${modelName(result.model)}${effort ? `/${effort}` : ''}`,
      task: taskOf(e.prompt, e.description),
      status: 'running',
      startedAt: await $.clock.now(),
      ms: null,
    }
    await update($, rows, (list) => [...list, row])
    tick ??= $.clock.every(1000, () => {
      $.ui.invalidate('ui.render')
      void (async () => {
        const now = await $.clock.now()
        for (const r of await read($, rows)) {
          if (r.status !== 'running' || warned.has(r.id) || now - r.startedAt < LONG_MS) continue
          warned.add(r.id)
          $.ui.toast(`model-ladder: ${r.cell} has run for 10 minutes and is still working`)
        }
      })()
    })
    return result
    // The band only watches; a failure in its bookkeeping must never stop a ladder agent.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId && (await read($, rows)).some((r) => r.id === e.agentId)) {
      const id = e.agentId
      const list = await update($, rows, (l) => l.map((r) => (r.id === id ? { ...r, status: 'done' as const, ms: e.durationMs } : r)))
      if (!list.some((r) => r.status === 'running')) { tick?.cancel(); tick = null }
      // A finished row keeps its check mark for a while before it leaves.
      $.clock.after(DONE_MS, () => { void update($, rows, (l) => l.filter((r) => r.id !== id)) })
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, rows)
    const running = shown.filter((r) => r.status === 'running')
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const now = await $.clock.now()
    const elapsed = (r: Row) => `${r.status === 'done' ? '✓ ' : ''}${seconds(r.ms ?? now - r.startedAt)}`
    const usage = (await $.session.usage()).rateLimits
      .filter((w) => WINDOW[w.kind])
      .map((w) => `${WINDOW[w.kind]} ${Math.round(w.percentUsed)}%`)
      .join(' · ')
    const folded = await read($, isFolded)
    const fold = <Button key="fold" plain dimColor label={folded ? '▾' : '▴'} onPress={() => update($, isFolded, (v) => !v)} />
    const last = running.at(-1)

    if (folded) {
      return (
        <Box>
          {fold}
          <Text bold> model-ladder </Text>
          <Text dimColor>── {usage || 'usage unknown'}{last ? ' · ' : ''}</Text>
          {last && <Text>{last.cell} · {elapsed(last)} · {fit(last.task, 30).trim()}</Text>}
        </Box>
      )
    }

    const config = await readConfig($)
    const guard = config.usageGuard ?? {}
    const threshold = guard.threshold ?? 90
    const save = (value: string) => {
      const n = Number(value.trim().replace(/%$/, ''))
      if (!(n >= 1 && n <= 100)) return $.ui.toast('threshold must be a number from 1 to 100')
      draft = null
      return editConfig($, (c) => ({ ...c, usageGuard: { enabled: true, threshold: n } }))
    }
    // Fixed-width columns line up in any font, unlike padding with spaces.
    // shortcut: outside the terminal the columns draw wider than bodyColumns says, so the task is capped at 22 cells; measure it there if the band gets wider.
    const taskCols = Math.max(10, Math.min((e.props.bodyColumns ?? 60) - 29 - 2, e.surface === 'terminal' ? Infinity : 22))
    const row = (key: string, model: string, time: string, task: string, dim = false) => (
      <Box key={key} flexWrap="nowrap">
        <Box width={20} flexShrink={0}><Text dimColor={dim} wrap="truncate-end">{model}</Text></Box>
        <Box width={9} flexShrink={0}><Text dimColor={dim}>{time}</Text></Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}><Text dimColor={dim} wrap="truncate-end">{task}</Text></Box>
      </Box>
    )
    return (
      <Box flexDirection="column">
        <Box>
          {fold}
          <Text bold> model-ladder </Text>
          <Text dimColor>── {usage || 'usage unknown'}{running.length ? '' : ' · idle'}</Text>
        </Box>
        {shown.length > 0 && row('head', 'model/effort', 'time', 'task', true)}
        {shown.map((r) => row(r.id, r.cell, elapsed(r), clip(r.task, taskCols)))}
        <Box>
          <Button key="guard" plain label={`usage guard: ${guard.enabled ? 'on' : 'off'}`}
            onPress={() => editConfig($, (c) => ({ ...c, usageGuard: { enabled: !guard.enabled, threshold } }))} />
          {guard.enabled && 'Input' in els && <Text dimColor>  threshold </Text>}
          {guard.enabled && 'Input' in els && (
            <Box flexShrink={0} width={e.surface === 'terminal' ? 6 : 10}>
              <els.Input key="threshold" value={String(threshold)} onInput={(value) => { draft = value }} onSubmit={(value) => save(value)} />
            </Box>
          )}
          {guard.enabled && 'Input' in els && <Text dimColor> % </Text>}
          {guard.enabled && 'Input' in els && <Button key="set" plain label="set" onPress={() => save(draft ?? String(threshold))} />}
          {guard.enabled && !('Input' in els) && <Text dimColor>  threshold {threshold}%</Text>}
        </Box>
      </Box>
    )
  })
}
