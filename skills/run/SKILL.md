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

## 0. Ladder or direct

If the task starts with `--ladder`, drop that flag from the task and go to step 1.

Otherwise do the task directly, without the ladder, when both hold:

- Small task: it touches one or two files and the design is already given, for example "implement this function as described".
- Large context: this session's context is above about 150k tokens.

In that case tell the user in one line: "Small task in a large session: doing it directly costs less than the ladder. Rerun with `--ladder` to force the ladder." Then do the task yourself, check it with the project's build or tests, and stop. Skip preflight and finish.

Otherwise go to step 1.

## 1. Preflight

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/preflight.mjs"` and act on `status`:

- `ERROR`: show `message` and stop.
- `STALE_RUN`, `OVERRIDDEN`, `DIRTY`: ask the user (show `message`, or the `files` for DIRTY: "run on top of these uncommitted changes?"). On yes, rerun preflight with every flag granted so far: `--clear-stale`, `--ignore-env`, `--allow-dirty`. On no, stop.
- `READY`: keep `workflowArgs`.

## 2. Workflow

Call the Workflow tool with name `model-ladder:ladder` and args `{ "task": "<task>", ...workflowArgs }` (a JSON object, not a string).

If it returns `status: "NEEDS_INPUT"`:

- `plan.question` is set: ask it. On an answer, call again with the task plus `\nClarification: <answer>`.
- `plan.needsAcceptance` is true: there is no verify step, so the user decides what done means. Show `plan.acceptance` as a proposal and ask them to confirm it or give their own criteria, one per line. Call again with the same args plus `"plan": <plan with acceptance set to their criteria>`.
- If the user declines either, go to step 3 with `{ "task": "<task>", "aborted": "<why>" }`.

If the Workflow call itself fails, go to step 3 with `{ "task": "<task>", "error": "<the error>" }`.

## 3. Finish (always, even after an abort or error)

Pipe the input to the finish script, which applies a verified result, removes worktrees and the run marker, and appends history:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/finish.mjs" <<'EOF'
{ "task": "<task>", "result": <the workflow's final result, unchanged> }
EOF
```

Print its output verbatim as your final message, in a `text` code block, and nothing else.
