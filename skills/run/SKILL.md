---
name: run
description: Run a task through model-ladder. It starts on the cheapest model and effort likely to succeed, verifies the result, and escalates on failure. Use for /model-ladder:run or when the user asks to run a task through model-ladder.
argument-hint: <task>
model: sonnet
effort: medium
---

# model-ladder

Task: $ARGUMENTS

If the task is empty, ask the user for it and stop. On the ladder path you only orchestrate: never edit the task's code yourself. Run commands from the repository root. Scripts print JSON or a report; act on them exactly as below.

## 1. Preflight

Run preflight with the plugin's skill options on stdin (Manage Plugins → Configure model-ladder; they are the defaults for every project, and a project's `.claude/model-ladder.json` overrides them with the same keys):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs" --plugin-options <<'EOF'
{ "task": "<task>", "worker_skills": "${user_config.worker_skills}", "verifier_skills": "${user_config.verifier_skills}", "direct_threshold": "${user_config.direct_threshold}" }
EOF
```

Put the task in `task` (the lock keeps it for the band's main-session row). Copy the other values exactly as they appear above. All are JSON strings: escape any `"`, `\` or line break inside them (`\"`, `\\`, `\n`). A value still reading `${...}` was not filled in; leave it as it is, preflight treats it as unset. Act on `status`:

- `ERROR`: show `message` and stop. If it says the plugin options are not valid JSON, fix the escaping and run preflight again instead.
- `STALE_RUN`, `OVERRIDDEN`, `DIRTY`: ask the user (show `message`, or the `files` for DIRTY: "run on top of these uncommitted changes?"). On yes, rerun preflight (same `--plugin-options` input) with every flag granted so far: `--clear-stale`, `--ignore-env`, `--allow-dirty`. On no, stop.
- `USAGE_LIMIT`: show `message` and stop. Do not call the workflow or the finish script.
- `READY`: keep `runId` and `workflowArgs`. If `usageNote` is set, show it to the user first, then continue.

Other model-ladder runs (Claude Code or Codex) may be active in the same repository. That is fine: step 2 checks that their files do not overlap with this run's.

### Phase (from READY until finish)

The band shows this session's phase while no ladder agent runs. Once you have a `runId`, record it in the run's lock:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/phase.mjs" <runId> needs-input
```

- `needs-input`: right before every question you ask the user (an acceptance, clarification or usage-risk question, an overlap or stale-run question from the claim).
- `awaiting-finish`: right after a Workflow call returns any status other than `BOUNDARY` or `ROUTED`, or throws, while you check the result and run finish.

Preflight sets `preflight` and the claim sets `claimed` by themselves. A phase `ERROR` never stops the run: carry on.

### Availability check (after preflight, before the workflow)

Read `workflowArgs.skills` (the `worker_skills` and `verifier_skills` text). Pick out every skill, plugin, slash command or MCP server it names (for example `ponytail`, `plugin:skill`, `mcp__server__tool`). Compare each name with what this session can use: the skills and slash commands listed in your context, the installed plugins, and the connected MCP tools (use ToolSearch if MCP tools are deferred). Ignore generic phrases such as "available UI/UX skills".

For each name you cannot find, tell the user once, before the workflow call, in their language. For example: "`ponytail` is not available in this project (it may not be installed, or only enabled in another project), so this run will not use it." Name the role (worker or verifier). Do not stop the run and do not edit `workflowArgs.skills`; it is a warning only. If you are unsure, say so instead of claiming it is missing. Remember these names for step 3.

## 2. Workflow

Call the Workflow tool with name `model-ladder:ladder` and args `{ "task": "<task>", "contextTokens": <estimate>, "contextWindow": <window>, "forceLadder": <bool>, ...workflowArgs }` (a JSON object, not a string). Pass `workflowArgs` unchanged.

- `workflowArgs.skills`: the effective role instructions after merging settings and selecting matching `project: instructions` lines by the main repo folder name, plus unprefixed global lines. Preflight removed project prefixes; do not edit, add or drop instructions. Empty means none.
- `workflowArgs.usageGuard`: the command the verifier runs to read the usage guard as the user has set it right now. Pass it unchanged, whether the guard is on or off.

- If `workflowArgs` already has `contextTokens` and `contextWindow`, they are the band's measured values: use them and do not estimate. `...workflowArgs` comes last in the args, so they override anything you put before it. Estimate only the ones it lacks.
- `contextTokens`: your estimate of this session's current context size in tokens. Orchestration re-reads this context on every turn.
- `contextWindow`: your estimate of this session's context window size in tokens (for example 200000 or 1000000). The workflow returns DIRECT for a small task when `contextTokens / contextWindow * 100` reaches `workflowArgs.directThreshold` (`off` = never); pass `workflowArgs` unchanged.
- `forceLadder`: true when the task starts with `--ladder`; drop that flag from the task.

Preflight enables the backend timing journal. Around **every** Workflow call, including the first routing call and every continuation, run the Node boundary recorder from the main repository:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/forecast.mjs" <<'EOF'
{ "runId": "<runId>", "event": "start" }
EOF
```

Immediately after the Workflow call returns, record its result unchanged (then, unless it is `BOUNDARY` or `ROUTED`, run `phase.mjs <runId> awaiting-finish`):

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/forecast.mjs" <<'EOF'
{ "runId": "<runId>", "event": "end", "result": <the workflow result> }
EOF
```

Keep the `forecast` the end recorder returns after the `ROUTED` call and pass it unchanged as `args.forecast` in every later Workflow call for this run; the workflow reads it before the first worker (see `USAGE_RISK` below). Carry the latest result's `journal` unchanged as `args.journal` into every subsequent Workflow call for this run. A `BOUNDARY` result means one agent finished: repeat with the same args plus that journal. Earlier outputs replay without calling agents. Keep the routed `plan` unchanged on execution continuations. Stop and use finish with `error` if a boundary recorder fails; never replay a failed/unrecorded call or invent timing. If the Workflow itself throws, use finish with `error`; the open boundary is censored.

If it returns `status: "ROUTED"`, claim the scope (below), then call again with the same args plus `"plan": <plan>`.

If it returns `status: "NEEDS_INPUT"`, run `phase.mjs <runId> needs-input` before you ask:

- `plan.question` is set: ask it. On an answer, finish this run with `aborted: "Task clarified; rerouting"`, then restart step 1 with the task plus `\nClarification: <answer>`. Keep previously granted preflight flags. A changed task gets a fresh journal; never replay the previous route against it.
- `plan.needsAcceptance` is true: there is no verify step, so the user decides what done means. Print `plan.acceptanceMessage` verbatim as a message (the question box shows one flat paragraph, so the list never goes in the question). Then ask `plan.acceptanceQuestion` verbatim, nothing added, with the options run / stop; the user gives their own criteria, one per line, through Other. Claim the scope (below), then call again with the same args plus `"plan": <plan with acceptance set to their criteria>`.
- `reason` is `USAGE_RISK`: the routed forecast judged a usage window insufficient or at risk for this run; no worker has started. Show the evidence in `usageRisk.windows` (each window's `status`, `used` %, `need` in forecast percentage points, `available`, and `resetsAt` in epoch ms shown as local time), then ask `usageRisk.question` with the options continue / stop. On continue, claim the scope (below), then call again with the same args plus `"acceptUsageRisk": true`, and keep it in every later call of this run. Never set it without the user's answer. On stop, go to step 3 with `aborted: "Declined usage-risk forecast"`. Unknown or missing usage data never asks. Continuing overrides only this forecast warning: usageGuard, Claude's usage limit (`USAGE_LIMIT`) and independent verification still apply.
- If the user declines, go to step 3 with `{ "task": "<task>", "runId": "<runId>", "aborted": "<why>" }`.

Claim the scope before every call that passes `plan`:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/claim.mjs" <<'EOF'
{ "runId": "<runId>", "scope": <plan.scope>, "readOnly": <plan.readOnly> }
EOF
```

- `READY`: make the call with `plan`.
- `NEEDS_INPUT`: another active run works on overlapping files. Run `phase.mjs <runId> needs-input`, then show `message` and ask: wait / stop. On wait, ask again when the user says the other run is done, then rerun the claim. If the user says a listed run is no longer running (its session closed or crashed), rerun the claim with `--clear-stale=<that runId>`. On stop, go to step 3 with `aborted`.
- `STALE_RUN`: run `phase.mjs <runId> needs-input`, then show `message` and ask; on yes rerun the claim with `--clear-stale`, on no go to step 3 with `aborted`.
- `ERROR`: go to step 3 with `{ "task": "<task>", "runId": "<runId>", "error": "<message>" }`.

If it returns `status: "DIRECT"`, the router judged the task small and this session too large for the ladder to pay off. Go to step 3 with that result; step 3 has you do the task and have it independently verified.

If it returns `status: "USAGE_LIMIT"`, the usage guard stopped the run, or an agent hit Claude's own subscription limit (`final.reason` has the message and reset time). Go to step 3 with that result unchanged; finish writes `HANDOFF.md` and keeps the last attempt's worktree. Never change the user's usage guard setting yourself.

If the Workflow call itself fails, go to step 3 with `{ "task": "<task>", "runId": "<runId>", "error": "<the error>" }`.

If the workflow returns `ERROR` with a journal, record its end boundary, then go to step 3 with `{ "task": "<task>", "runId": "<runId>", "error": "<result.error>" }`.

## 3. Finish (always, even after an abort or error)

If stopping another registered runner fails under the sandbox, report its run ID and the shutdown error. Do not claim it stopped, clear its live lock, or bypass permissions. Claude host sessions and hosted agents have no cancellation API here; use their normal host controls.

Pipe the input to the finish script, which applies a verified result, removes this run's worktrees and lock, and appends history:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/finish.mjs" <<'EOF'
{ "task": "<task>", "runId": "<runId>", "result": <the workflow's final result, unchanged> }
EOF
```

Read its output; do not paste the English report as is. Default application does not commit or push. commit: true is a separate user-controlled option, never implicit permission from a request to fix code. If the result was `DIRECT`, do the task yourself and check it with the project's build or tests. Then have it verified independently before you report: dispatch the Agent tool with `subagent_type: "model-ladder:verifier"`, using the `verifier` model and effort from `.claude/model-ladder.json` (default `haiku`/`low`, the cheapest tier). Its prompt gives the task, the verify command (`verify` in the config, or the acceptance criteria the user gave) and tells it to inspect your diff (`git diff` plus new untracked files) and to check only, never modify. Report done only if it passes. If it fails, take its reasons, fix the problem yourself, and dispatch the verifier again; stop after three failed verifications and report the last reasons as unresolved. Otherwise write one final message that summarizes the result in the language the user uses in this session: the status, which files changed (applied or not), the verification result, and any limits or follow-ups (kept worktree or patch, `HANDOFF.md`, failed attempts, update notes). Keep file names, commands, paths, model names and status codes in their original form. Capability blockers: if the workflow result shows any role (router, worker, test-writer, verifier) reporting that a skill, plugin, slash command or MCP server was missing or unusable (look in `attempts[].reason`, `modelContext`, `diagnosisContext` and `winner.summary`), or the availability check found names missing, list them in the summary as a reminder, naming the role. If none, say nothing about it.

If the status was `USAGE_LIMIT`, finish has written a template `.model-ladder/HANDOFF.md`. Keep it as the fallback, then write the real one yourself before the final message, following `${CLAUDE_PLUGIN_ROOT}/skills/handoff/SKILL.md` steps 2 and 3 (read that file if unsure): overwrite `.model-ladder/HANDOFF.md` using your whole conversation with the user, in the language the user uses in this session, with the sections `## Goal`, `## User preferences and decisions`, `## Done and not done`, `## Suggested next steps` and `## How to resume`. Then add `## Appendix: program-generated verification (authoritative)` and paste the template finish wrote unchanged (minus its title line): attempts PASS/FAIL, status, worktree and resume command. AI-written sections and program-generated data must stay clearly separate, and the appendix wins where they differ. If you can no longer write the file (for example you are out of usage), leave the template as it is. Mention in the summary that `HANDOFF.md` is AI-written with a verified appendix.

Send the summary once, with nothing else after it.
