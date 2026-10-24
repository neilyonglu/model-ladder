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
// Largest unit only, floored: 42s, 5m, 4h, 3d.
const span = (ms: number) => (ms < 60000 ? `${Math.floor(ms / 1000)}s` : ms < 3600000 ? `${Math.floor(ms / 60000)}m` : ms < 86400000 ? `${Math.floor(ms / 3600000)}h` : `${Math.floor(ms / 86400000)}d`)
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))
const DONE_MS = 10000
const LONG_MS = 10 * 60 * 1000
const SETTLE_MS = 5000
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
// Time until a window resets: "54m", "2h" or "3d"; empty when unknown or already past.
const remaining = (resetsAt: string | null | undefined, now: number) => {
  const ms = Date.parse(resetsAt ?? '') - now
  return ms > 0 ? span(ms) : ''
}

// Same shape as scripts/finish.mjs handoff(), for a run that is still going or just ended.
const handoffText = (running: Row[], now: number, last: any) => {
  const out = ['# model-ladder handoff', '']
  if (running.length) out.push('## Running', ...running.map((r) => `- ${r.cell}, ${span(now - r.startedAt)}: ${r.task}`), '')
  if (last) {
    out.push('## Task', last.task, '', `## Last run (${last.date}): ${last.status}`, `Start: ${last.start ? `${last.start.model}/${last.start.effort}` : 'none'}`, '', '## Attempts',
      ...(last.attempts?.length ? last.attempts.map((a: any, i: number) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`) : ['none']),
      '', `Applied: ${last.applied ? 'yes' : 'no'}`, '')
  }
  out.push('## Resume', `Run \`/model-ladder:run ${last?.task ?? running.at(-1)?.task}\` again.`, '')
  return out.join('\n')
}

export const register: Register = (on, options) => {
  // Redraws once a second while an agent runs, so its elapsed time moves.
  let tick: Timer | null = null
  // What the person typed in the threshold field, until it saves.
  let draft: string | null = null
  // Saves the typed threshold once typing pauses for a second; Enter saves at once.
  let settle: Timer | null = null
  // Agents already told about; a long run is only reported, never stopped.
  const warned = new Set<string>()

  // Records the subscription usage where preflight and the verifier read it, so the usage guard needs no statusline.
  // It runs with the band hidden too: the guard depends on it, not on the drawing.
  on('session.measure', async ($, e, next) => {
    const window = (kind: string) => {
      const w = e.rateLimits.find((r) => r.kind === kind)
      return w ? { used_percentage: w.percentUsed, resets_at: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : null } : null
    }
    if (e.rateLimits.length) {
      const usage = { five_hour: window('five_hour'), seven_day: window('seven_day'), updatedAt: Math.floor((await $.clock.now()) / 1000) }
      await $.fs.write(`${await $.session.cwd()}/.model-ladder/usage.json`, JSON.stringify(usage)).catch(() => undefined)
    }
    return next(e)
  })

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
    if (e.props.hasSurvey || options.band === false) return next(e)
    const shown = await read($, rows)
    const running = shown.filter((r) => r.status === 'running')
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const now = await $.clock.now()
    const elapsed = (r: Row) => `${r.status === 'done' ? '✓ ' : ''}${span(r.ms ?? now - r.startedAt)}`
    const usage = (await $.session.usage()).rateLimits
      .filter((w) => WINDOW[w.kind])
      .map((w) => {
        const left = remaining(w.resetsAt, now)
        return `${left ? `${left}/` : ''}${WINDOW[w.kind]} ${Math.round(w.percentUsed)}%`
      })
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
    // Plain-string settings from the plugin manager; shown so the run's companions are visible.
    const withs = [options.worker_skills && `worker ${options.worker_skills}`, options.verifier_skills && `verifier ${options.verifier_skills}`].filter(Boolean)
    const handoff = async () => {
      const dir = `${await $.session.cwd()}/.model-ladder`
      let last = null
      try { last = JSON.parse((await $.fs.read(`${dir}/history.jsonl`)).trim().split('\n').at(-1) ?? '') } catch { /* no history yet */ }
      const live = (await read($, rows)).filter((r) => r.status === 'running')
      if (!live.length && !last) return $.ui.toast('model-ladder: no run to hand off')
      try {
        await $.fs.write(`${dir}/HANDOFF.md`, handoffText(live, await $.clock.now(), last))
        $.ui.toast(`model-ladder: wrote ${dir}/HANDOFF.md`)
      } catch (error) {
        $.ui.toast(`model-ladder: handoff failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const guard = config.usageGuard ?? {}
    // Matches the default in scripts/preflight.mjs: a missing setting is on.
    const enabled = guard.enabled ?? true
    const threshold = guard.threshold ?? 90
    const save = (value: string) => {
      const n = Number(value.trim().replace(/%$/, ''))
      if (!(n >= 1 && n <= 100)) return $.ui.toast('threshold must be a number from 1 to 100')
      draft = null
      return editConfig($, (c) => ({ ...c, usageGuard: { enabled: true, threshold: n } }))
    }
    // Fixed-width columns line up in any font, unlike padding with spaces.
    // Terminal cuts the task itself; elsewhere the full task goes to the row and truncate-end adds the ellipsis at the band's edge.
    const taskCols = Math.max(10, (e.props.bodyColumns ?? 60) - 29 - 2)
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
        {withs.length > 0 && <Text dimColor>with: {withs.join(' · ')}</Text>}
        {shown.length > 0 && row('head', 'model/effort', 'time', 'task', true)}
        {shown.map((r) => row(r.id, r.cell, elapsed(r), e.surface === 'terminal' ? clip(r.task, taskCols) : r.task))}
        <Box>
          <Button key="guard" plain label={`usage guard: ${enabled ? 'on' : 'off'}`}
            onPress={() => editConfig($, (c) => ({ ...c, usageGuard: { enabled: !enabled, threshold } }))} />
          {enabled && 'Input' in els && <Text dimColor>  threshold </Text>}
          {enabled && 'Input' in els && (
            <Box flexShrink={0} width={e.surface === 'terminal' ? 6 : 10}>
              <els.Input key="threshold" value={String(threshold)}
                onInput={(value) => {
                  draft = value
                  settle?.cancel()
                  settle = $.clock.after(SETTLE_MS, () => {
                    settle = null
                    const typed = draft?.trim() ?? ''
                    if (typed && typed !== String(threshold)) void save(typed)
                  })
                }}
                onSubmit={(value) => { settle?.cancel(); settle = null; return save(value) }} />
            </Box>
          )}
          {enabled && 'Input' in els && <Text dimColor> % </Text>}
          {enabled && !('Input' in els) && <Text dimColor>  threshold {threshold}%</Text>}
          <Text dimColor>  </Text>
          <Button key="handoff" plain label="handoff now" onPress={() => { void handoff() }} />
        </Box>
      </Box>
    )
  })
}
