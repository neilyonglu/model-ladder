import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Row } from './types'
import { roundSpan } from './remaining.mjs'
import { formatContext } from './context.mjs'
import { addRow, anyRunning, finishRow, isRedo, removeRow, runCount } from './rows.mjs'
import { GUARD_DEFAULT, mergeConfig, parseThreshold, pluginLayer, projectPins, projectSkills, setGuard, userConfigPath } from '../config-layers.mjs'

const rows = atom({ plugin: 'model-ladder', key: 'rows' } as const, [])
const isFolded = atom({ plugin: 'model-ladder', key: 'isFolded' } as const, false)
const areSkillsFolded = atom({ plugin: 'model-ladder', key: 'areSkillsFolded' } as const, true)
// Latest context window usage from session.measure as shown text ("ctx 35k/1M"); empty when unknown.
const contextText = atom({ plugin: 'model-ladder', key: 'contextText' } as const, '')


type Config = { usageGuard?: { enabled?: boolean; threshold?: number }; worker_skills?: unknown; verifier_skills?: unknown; [key: string]: unknown }

// Layers as in hooks/config-layers.mjs: defaults, the user's ~/.claude/model-ladder.json (plus the plugin's skill
// options), then the project's .claude/model-ladder.json. The band writes only the user's file, and only on a press.
const BAND_DEFAULTS = { usageGuard: GUARD_DEFAULT, worker_skills: '', verifier_skills: '' }
const projectPath = async ($: EngineInterface) => `${await $.session.cwd()}/.claude/model-ladder.json`
const userPath = async ($: EngineInterface) => userConfigPath('claude', {
  MODEL_LADDER_USER_CONFIG: await $.env.get('MODEL_LADDER_USER_CONFIG'),
  CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
}, (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~')
async function readJson($: EngineInterface, path: string): Promise<Config> {
  try { return JSON.parse(await $.fs.read(path)) } catch { return {} }
}
async function editUserConfig($: EngineInterface, edit: (c: Config) => Config) {
  const path = await userPath($)
  let text: string | null = null
  try { text = await $.fs.read(path) } catch { /* no file yet */ }
  let current: Config = {}
  try { current = text === null ? {} : JSON.parse(text) } catch {
    // Never overwrite a file the person is in the middle of editing by hand.
    return $.ui.toast(`model-ladder: ${path} is not valid JSON; fix it, then try again`)
  }
  await $.fs.write(path, `${JSON.stringify(edit(current), null, 2)}\n`)
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
// Time until a window resets, rounded to its largest unit: "54m", "2h" or "3d"; empty when unknown or already past.
const remaining = (resetsAt: string | null | undefined, now: number) => {
  const ms = Date.parse(resetsAt ?? '') - now
  return ms > 0 ? roundSpan(ms) : ''
}

// The skill that has the main session write HANDOFF.md from its conversation (skills/handoff/SKILL.md).
const HANDOFF_COMMAND = '/model-ladder:handoff'

// Template fallback, same shape as scripts/finish.mjs handoff(), for a run that is still going or just ended.
const handoffText = (running: Row[], now: number, last: any) => {
  const out = ['# model-ladder handoff', '']
  if (running.length) out.push('## Running', ...running.map((r) => `- ${r.cell}, ${span(now - r.startedAt)}: ${r.task}`), '')
  if (last) {
    out.push('## Task', last.task, '', `## Last run (${last.date}): ${last.status}`, `Start: ${last.start ? `${last.start.model}/${last.start.effort}` : 'none'}`, '', '## Attempts',
      ...(last.attempts?.length ? last.attempts.map((a: any, i: number) => `${i + 1}. ${a.cell}: ${a.pass ? 'PASS' : 'FAIL'} ${a.reason}`) : ['none']),
      '', `Applied: ${last.applied ? 'yes' : 'no'}`, '')
    const context = (last?.attempts ?? []).flatMap((a: any) => [a.modelContext, a.diagnosisContext].filter(Boolean))
    if (context.length) out.push('## Model context (unverified)', ...context.map((c: any) => `### ${c.source} — ${c.updatedAt}\n${c.text}`), '', 'Generated status and verification above are authoritative. Model context is unverified; timestamps identify its source and age.', '')
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
  // Bumped on Enter: the Input clears itself on submit, and a new key remounts it showing the value again.
  let submits = 0
  // Agents already told about; a long run is only reported, never stopped.
  const warned = new Set<string>()
  // The task last seen in each workflow run, for agents whose prompt has no TASK line.
  const tasks = new Map<string, string>()
  // Workflow runs whose verifier has run; a worker spawned later in the same run is a redispatch.
  const verified = new Set<string>()
  // Last context size written to .model-ladder/context.json, so it is rewritten only when it changes.
  let lastContext = ''

  // Records the subscription usage where preflight and the verifier read it, so the usage guard needs no statusline.
  // It runs with the band hidden too: the guard depends on it, not on the drawing.
  on('session.measure', async ($, e, next) => {
    const text = formatContext(e.context)
    if (text !== (await read($, contextText))) {
      await update($, contextText, () => text)
      $.ui.invalidate('ui.render')
    }
    // The measured context size, which preflight hands the workflow for its DIRECT check; unknown tokens are not written.
    const tokens = e.context?.tokens
    if (typeof tokens === 'number') {
      const key = `${tokens}/${e.context?.window ?? ''}`
      if (key !== lastContext) {
        lastContext = key
        const context = { tokens, window: e.context?.window ?? null, updatedAt: Math.floor((await $.clock.now()) / 1000) }
        await $.fs.write(`${await $.session.cwd()}/.model-ladder/context.json`, JSON.stringify(context)).catch(() => { lastContext = '' })
      }
    }
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
    const hasTask = /TASK[^\n]*\n\s*[^\n]+/.test(e.prompt)
    if (hasTask) tasks.set(e.workflow.runId, taskOf(e.prompt, ''))
    const task = hasTask ? taskOf(e.prompt, '') : (tasks.get(e.workflow.runId) ?? e.description.trim())
    // Worker rows show just the task; the others say what they do with it.
    const isWorker = /^model-ladder:(worker|test-writer)$/.test(e.subagentType)
    const what = e.description.replace(/\s*\S+\/\S+$/, '')
    const effort = e.description.match(/\S+\/(\S+)/)?.[1]
    const role = e.subagentType.slice('model-ladder:'.length) as Row['role']
    // shortcut: the turn.complete event type is not available here, so FAIL is inferred from "a worker spawns after a verifier in the same run"; this assumes the ladder only redispatches a worker after a FAIL, upgrade to the verifier's actual result once turn.complete exposes its output.
    const redo = isRedo(verified, e.workflow.runId, isWorker)
    if (role === 'verifier') verified.add(e.workflow.runId)
    const row: Row = {
      role,
      redo,
      run: e.workflow.runId,
      id: result.agentId,
      cell: `${modelName(result.model)}${effort ? `/${effort}` : ''}`,
      task: isWorker ? task : `${what}: ${task}`,
      status: 'running',
      startedAt: await $.clock.now(),
      ms: null,
    }
    await update($, rows, (list) => addRow(list, row))
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
      const list = await update($, rows, (l) => finishRow(l, id, e.durationMs) as Row[])
      if (!anyRunning(list)) { tick?.cancel(); tick = null }
      // A finished row keeps its check mark for a while before it leaves.
      $.clock.after(DONE_MS, () => { void update($, rows, (l) => removeRow(l, id)) })
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
    const usageLine = [usage, await read($, contextText)].filter(Boolean).join(' · ')
    const folded = await read($, isFolded)
    const fold = <Button key="fold" plain dimColor label={folded ? '▾' : '▴'} onPress={() => update($, isFolded, (v) => !v)} />
    const last = running.at(-1)
    const runs = runCount(shown)
    // With 2+ runs each row says which run it belongs to, by that run's task.
    const tag = (r: Row) => (runs > 1 ? `${fit(tasks.get(r.run) ?? '', 20).trim()} ` : '')
    const dot = last && <Text>{' ' + (last.role === 'verifier' ? '🔵' : last.redo ? '🔴' : '🟢')}</Text>

    if (folded) {
      return (
        <Box>
          {fold}
          {dot}
          <Text bold> model-ladder </Text>
          <Text dimColor>── {usageLine || 'usage unknown'}{last ? ' · ' : ''}</Text>
          {last && runs > 1 && <Text dimColor>{runs} runs · </Text>}
          {last && <Text>{last.cell} · {elapsed(last)} · {fit(last.task, 30).trim()}</Text>}
        </Box>
      )
    }

    const project = await readJson($, await projectPath($))
    const config = projectSkills(
      mergeConfig(BAND_DEFAULTS, { ...(await readJson($, await userPath($))), ...pluginLayer(options) }, project),
      (await $.session.repo())?.root,
    )
    // Show the instructions in effect here (project key, else plugin option), not a claim that every mentioned skill was invoked.
    const skill = (role: string, value: unknown) => typeof value === 'string' && value.trim() ? `${role} ${value}` : null
    const withs = [skill('worker', config.worker_skills), skill('verifier', config.verifier_skills)].filter(Boolean)
    const skillText = withs.join(' · ')
    const skillsFolded = await read($, areSkillsFolded)
    const handoff = async () => {
      const dir = `${await $.session.cwd()}/.model-ladder`
      let last = null
      try { last = JSON.parse((await $.fs.read(`${dir}/history.jsonl`)).trim().split('\n').at(-1) ?? '') } catch { /* no history yet */ }
      const live = (await read($, rows)).filter((r) => r.status === 'running')
      if (!live.length && !last) return $.ui.toast('model-ladder: no run to hand off')
      try {
        // The template is written first: it is the fallback if the main session never gets to write the AI version.
        await $.fs.write(`${dir}/HANDOFF.md`, handoffText(live, await $.clock.now(), last))
      } catch (error) {
        return $.ui.toast(`model-ladder: handoff failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Asks the main session to write the real one: $.prompt.submit runs once the session is idle, as the person's own words.
      const fallback = () => $.ui.toast(`model-ladder: wrote the template ${dir}/HANDOFF.md; run ${HANDOFF_COMMAND} for the AI-written version`)
      try {
        void Promise.resolve($.prompt.submit({ text: HANDOFF_COMMAND, asUser: true })).catch(fallback)
        $.ui.toast(`model-ladder: wrote the template ${dir}/HANDOFF.md and asked this session to write the AI version (${HANDOFF_COMMAND})`)
      } catch {
        fallback()
      }
    }
    const guard = config.usageGuard ?? {}
    // Display only: a missing setting shows as the default (on, 90%) and is never written back.
    const enabled = guard.enabled ?? GUARD_DEFAULT.enabled
    const threshold = guard.threshold ?? GUARD_DEFAULT.threshold
    // The project file can still pin a guard field; the person's change is saved, and they are told it does not apply here.
    const pinNote = (field: string) => projectPins(project, field)
      ? $.ui.toast(`model-ladder: saved to your own settings, but .claude/model-ladder.json sets usageGuard.${field} for this project and wins`)
      : undefined
    // Changes the threshold alone: an off guard stays off.
    const save = async (value: string) => {
      const n = parseThreshold(value)
      if (n === null) return $.ui.toast('threshold must be a number from 1 to 100')
      draft = null
      await editUserConfig($, (c) => setGuard(c, { threshold: n }))
      pinNote('threshold')
    }
    const toggle = async () => {
      await editUserConfig($, (c) => setGuard(c, { enabled: !enabled }))
      pinNote('enabled')
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
          {dot}
          <Text bold> model-ladder </Text>
          <Text dimColor>── {usageLine || 'usage unknown'}{running.length ? '' : ' · idle'}</Text>
        </Box>
        {withs.length > 0 && (
          <Box flexWrap="nowrap">
            <Button key="skills-fold" plain dimColor label={skillsFolded ? '▸' : '▾'}
              onPress={() => update($, areSkillsFolded, (v) => !v)} />
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap={skillsFolded ? 'truncate-end' : undefined}>{skillsFolded ? skillText.replace(/\s+/g, ' ') : skillText}</Text>
            </Box>
          </Box>
        )}
        {shown.length > 0 && row('head', 'model/effort', 'time', 'task', true)}
        {shown.map((r) => row(r.id, r.cell, elapsed(r), e.surface === 'terminal' ? clip(tag(r) + r.task, taskCols) : tag(r) + r.task))}
        <Box>
          <Button key="guard" plain label={`usage guard: ${enabled ? 'on' : 'off'}`}
            onPress={() => { void toggle() }} />
          {enabled && 'Input' in els && <Text dimColor>  threshold </Text>}
          {enabled && 'Input' in els && (
            <Box flexShrink={0} width={e.surface === 'terminal' ? 6 : 10}>
              <els.Input key={`threshold-${submits}`} value={String(threshold)}
                onInput={(value) => {
                  draft = value
                  settle?.cancel()
                  settle = $.clock.after(SETTLE_MS, () => {
                    settle = null
                    const typed = draft?.trim() ?? ''
                    if (typed && typed !== String(threshold)) void save(typed)
                  })
                }}
                onSubmit={async (value) => { settle?.cancel(); settle = null; await save(value); submits++; $.ui.invalidate('ui.render') }} />
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
