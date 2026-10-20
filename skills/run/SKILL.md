---
name: run
description: Run a coding task through model-ladder. It starts on the cheapest model and effort likely to succeed, verifies the result, and escalates on failure. Use for /model-ladder:run or when the user asks to run a task through model-ladder.
argument-hint: <task>
model: sonnet
effort: medium
---

# model-ladder

Task: $ARGUMENTS

If the task is empty, ask the user for it and stop. On the ladder path you only orchestrate: never edit the task's code yourself. Run commands from the repository root. Scripts print JSON or a report; act on them exactly as below.

## 1. Preflight

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"` and act on `status`:

- `ERROR`: show `message` and stop.
- `STALE_RUN`, `OVERRIDDEN`, `DIRTY`: ask the user (show `message`, or the `files` for DIRTY: "run on top of these uncommitted changes?"). On yes, rerun preflight with every flag granted so far: `--clear-stale`, `--ignore-env`, `--allow-dirty`. On no, stop.
- `READY`: keep `workflowArgs`.

## 2. Workflow

Call the Workflow tool with name `model-ladder:ladder` and args `{ "task": "<task>", "contextTokens": <estimate>, "forceLadder": <bool>, ...workflowArgs }` (a JSON object, not a string).

- `contextTokens`: your estimate of this session's current context size in tokens. The router weighs it against the task: orchestration re-reads this context on every turn.
- `forceLadder`: true when the task starts with `--ladder`; drop that flag from the task.

If it returns `status: "NEEDS_INPUT"`:

- `plan.question` is set: ask it. On an answer, call again with the task plus `\nClarification: <answer>`.
- `plan.needsAcceptance` is true: there is no verify step, so the user decides what done means. First print the proposal as a message, never inside the question, since the question box shows one flat paragraph:

  ```md
  **Ladder start:** <model>/<effort> — <the router's reason, one line>

  **Acceptance criteria (proposed)**
  1. <criterion>
  2. <criterion>
  ```

  Then ask a short question ("Run with these criteria?") with the options run / stop; the user gives their own criteria, one per line, through Other. Call again with the same args plus `"plan": <plan with acceptance set to their criteria>`.
- If the user declines either, go to step 3 with `{ "task": "<task>", "aborted": "<why>" }`.

If it returns `status: "DIRECT"`, the router judged the task small and this session too large for the ladder to pay off. Go to step 3 with that result.

If the Workflow call itself fails, go to step 3 with `{ "task": "<task>", "error": "<the error>" }`.

## 3. Finish (always, even after an abort or error)

Pipe the input to the finish script, which applies a verified result, removes worktrees and the run marker, and appends history:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/finish.mjs" <<'EOF'
{ "task": "<task>", "result": <the workflow's final result, unchanged> }
EOF
```

Print its output verbatim in a `text` code block. If the result was `DIRECT`, then do the task yourself, check it with the project's build or tests, and report what changed. Otherwise the printed output is your final message, with nothing else.
