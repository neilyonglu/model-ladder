# model-ladder — Design

Maintainer notes. User docs are in [README.md](README.md). A router model picks the start and diagnoses failures; code enforces the escalation rules. v1.7.1 supports Claude Code and Codex.

## Goals

Cheaper per verified task than a strong model at high effort; never report done without verification; never touch uncommitted work; two-command install, no proxy or API key. Non-goals: Gemini, best-of-N, dollar cost.

## Layout

```text
.claude-plugin/ .codex-plugin/ .agents/plugins/   manifests (same name and version), marketplace
skills/run/SKILL.md            Claude entry: preflight, workflow, finish
codex-skills/model-ladder/     Codex entry: packaged Node runner
workflows/ladder.js            Claude orchestration + canonical pure rules
agents/                        router, worker, test-writer, verifier
scripts/  preflight.mjs finish.mjs common.mjs            Claude config, snapshot, apply, report
          codex-run.mjs codex-exec.mjs codex-worktree.mjs codex-usage.mjs codex-live.mjs watch.mjs
          usage-statusline.mjs sync-rules.mjs update-check.mjs
hooks/    hooks.json codex-hooks.json autorun.mjs guard.mjs band.json band/
tests/    unit/ helpers/ fixture-repo/ e2e/
```

`workflows/ladder.js` pure block is canonical; `scripts/sync-rules.mjs` generates `scripts/ladder-rules.mjs` for Node imports and a unit test rejects drift.

## Roles (Claude Code)

| Role | Model / effort | Tools | Job |
|---|---|---|---|
| Skill (main session) | sonnet / medium | all | Run the two scripts and the workflow; ask the user |
| Router | `router` (sonnet/low) | Read, Grep, Glob | Start cell, diagnoses, final explanation |
| Worker / test-writer | current cell | Read, Grep, Glob, Edit, Write, Bash | Implement the brief in a fresh worktree |
| Verifier | `verifier` (haiku/low) with a verify command, else router | Read, Grep, Glob, Bash | Protected check, verify or judge acceptance |

Running a command needs no judgment (cheap verifier); judging criteria does (router's model). The skill is pinned to sonnet/medium because it runs `git apply` and worktree removal.

## Config

Keys, defaults and meanings: [README Configure](README.md#configure); source of truth is `DEFAULTS` in `scripts/preflight.mjs`. Top-level keys replace defaults except `usageGuard`, which merges per field. `preflight.mjs` validates and stops naming each problem. Codex uses `.codex/model-ladder.json` with its own defaults (`scripts/codex-run.mjs`).

## Grid and legal moves

| Move | Rule |
|---|---|
| Same tier, higher effort | Up to `maxEffortJump` steps |
| Next tier | Only `tier + 1`, any effort (may be lower: sonnet/high -> opus/low) |
| Down, sideways, skipping a tier | Never |

`legalMoves(cell, tiers)` is pure. The workflow hands the router the legal list (multiple choice, not rules from memory). Illegal or malformed answer -> default move: next effort in the tier, else lowest effort of the next tier.

## Flow (Claude Code)

```text
1. node scripts/preflight.mjs     -> READY + workflowArgs, or a status needing the user
2. Workflow model-ladder:ladder   -> VERIFIED | FAILED | STOPPED | NEEDS_INPUT | DIRECT
3. node scripts/finish.mjs        -> apply, cleanup, history, report
```

Deterministic work lives in scripts (about five model calls per main session); workflows cannot touch the filesystem.

### Preflight
| Status | Meaning | Flag on yes |
|---|---|---|
| `ERROR` | Not a git repo with a commit, or invalid config | — |
| `STALE_RUN` | Run marker exists (active or crashed) | `--clear-stale` |
| `OVERRIDDEN` | `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set | `--ignore-env` |
| `DIRTY` | Uncommitted changes | `--allow-dirty` |
| `USAGE_LIMIT` | Recorded usage >= threshold; no marker written | wait for reset |
| `READY` | `workflowArgs`: config, protection, `hasVerifySkill`, setup patch/files | — |

Dirty runs snapshot through a temporary index (`GIT_INDEX_FILE`), leaving the real index untouched: `baseTree` (HEAD + changes, untracked included), `setup.patch` (`git diff --cached --binary HEAD`, applied first by the worker), `setupFiles` (exempt from the protected check). Clean tree: `baseTree` = `HEAD^{tree}`. Run files live in `<repo>/.model-ladder/` (`run.json` marker, `state.json`, `setup.patch`, `result.patch`, `history.jsonl`, `usage.json`, `HANDOFF.md`), not under `.git` or `.claude`, where headless runs could not delete or edit them.

### Ladder or direct
Orchestration re-reads the caller's context, so in long sessions it can cost more than a cheap worker saves. The workflow returns `DIRECT` when the task is small (router's `small`: one or two files, design given) and context is large (`contextTokens` from the skill, threshold `LARGE_CONTEXT` ~300k in `workflows/ladder.js`). The threshold is code, not router judgment (sonnet/low misread "about 500000 tokens"). `--ladder` sets `forceLadder`. A direct case still costs one router call; thresholds are a guess, not measured.

### Workflow
Route: the router returns start cell + reason, goal, scope, verify step, acceptance criteria, `allowTests` + reason, optional `question` (set when the task is too vague; else "make the shop better" passes on green tests). Verify source, first match wins: config `verify`; project verify skill `.claude/skills/verify/`; an existing test suite (the router may never write its own check, even a one-line assert); else `needsAcceptance` (user confirms criteria). Two vendored skills (from pstack, see NOTICE.md) help here: `/model-ladder:create-verification-skill` generates `.claude/skills/verify/`, `/model-ladder:maintain-verification-skill` keeps it honest. `NEEDS_INPUT` returns early; the skill asks and calls again.

```text
cell = start; history = []
for attempt in 1..maxAttempts:
    w = worker(brief(cell, history, hint))      # isolation: worktree
    v = verifier(w.worktreePath)                # skipped if w died, blocked or changed nothing
    history.push({cell, w, v, tokens})
    if v.pass: return VERIFIED
    if attempt == maxAttempts or no legal moves: break
    d = router.diagnose(history, legalMoves(cell))
    if d.action starts with "stop_": return STOPPED
    cell = d.choice if legal else defaultMove(cell); hint = d.hint
final = router.explain(history); return FAILED
```

- Each attempt starts from a clean worktree at the base; failures carry forward as summaries and hints, not code.
- `agent()` returns null on death and throws on invalid structured output; both are failed steps (failed worker = failed attempt, failed diagnosis = default move). Only a failed route stops the run.
- Router sees the latest attempt in full (verify output last 200 lines), earlier ones as summaries. Worst case 14 agent calls. The result is compact because the main session copies it into finish.

| Diagnosis | Meaning | Move |
|---|---|---|
| `raise_effort` | Right direction, not deep enough | Higher effort, same tier |
| `raise_model` | Knowledge/capability gap, incl. invalid output | Next tier |
| `stop_environment` | Missing dependency, broken setup, unreachable service | Stop |
| `stop_unclear` | Ambiguous task | Stop |

`status: "blocked"` (worker judged the task impossible) counts as a failure and goes to diagnosis.

### Finish
Reads the workflow result (or abort reason / error) on stdin. Always:

- VERIFIED: stage the winning worktree, `git write-tree`, apply `git diff --binary baseTree resultTree` to the working tree (diffing against `baseTree` keeps the user's own changes out).
- `commit` true: commit only the patch's files as `model-ladder: <goal>`.
- Patch conflicts (user edited the same files): keep the worktree and `result.patch`, report where.
- Remove the run's worktrees and `worktree-wf_*` branches (failed ones kept when `keepFailed`); delete marker, state and setup patch (a crash never leaves the guard armed); append history; print the report.

## Brief
Fields: GOAL, TASK, SCOPE, ACCEPTANCE (user, else router), VERIFY (config / verify skill / router), FORBIDDEN (preflight + `allowTests`), SETUP (dirty only), PREVIOUS and HINT (attempt 2+), REPORT `worktreePath`. Test-writing tasks run on `test-writer`, others on `worker`; they differ only in test protection, so the hook can tell by `agent_type` and the marker is written once, before the router decides `allowTests`.

## Protected paths

```text
tests (worker only)  **/test_*.py **/*_test.py **/tests/** **/__tests__/** **/*.test.* **/*.spec.* **/src/test/**
always               .claude/model-ladder.json, plus config "protected"
```

The ladder config is always protected, or a worker could rewrite the verify command. Two layers:

1. **Hook** (`guard.mjs`, PreToolUse, early, best effort): blocks (exit 2) only when the caller is a ladder worker/test-writer, the marker exists and the path matches. Fails open if Node is missing. Outside a run the user is never blocked.
2. **Verifier diff** (always): `git status --porcelain --untracked-files=all` in the worktree against the same globs, catching Bash edits. Ignores artifacts the verify step rewrites (`__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules`, `target`, `build`, `dist`, `coverage`).

Codex additionally protects npm scripts (incl. nested manifests), npm config, the selected verify skill dir, and selected build manifests; it compares actual Git trees before and after verification. New files under `dist`, `build`, `target` are excluded; files already in the baseline tree stay checked.

## Report and history
FAILED and STOPPED reports end with the router's explanation. Tokens are output tokens per agent call (`budget.spent()` delta); input tokens, the main session and dollars are unavailable. History: one JSON line per run in `.model-ladder/history.jsonl` (task, status, start, attempts with cell/result/reason/action/tokens, applied, committed).

## Releases
Claude Code offers an update only when `version` in `.claude-plugin/plugin.json` changes.

- `scripts/update-check.mjs` reads the published `plugin.json` at most daily (cached in the OS temp dir); finish appends an update line. Silent on failure; `MODEL_LADDER_NO_UPDATE_CHECK=1` disables; nothing is sent.
- CI (`.github/scripts/check-version.mjs`) fails if plugin dirs (`.claude-plugin`, `.codex-plugin`, `.agents/plugins`, `codex-skills`, `skills`, `agents`, `hooks`, `scripts`, `workflows`) changed since the latest `v*` tag without a version bump. Docs-only changes need none.
- Each release: sync both manifest versions, bump, `CHANGELOG.md` entry, `vX.Y.Z` tag and GitHub Release.

## Codex runtime

- The standalone runner `scripts/codex-run.mjs` owns route, attempts, verification, diagnosis and incremental patching. It calls native `codex exec` with argument arrays, stdin, explicit model/effort, strict JSON schemas, ephemeral sessions and read-only or workspace-write sandboxes; it never disables approvals or sandbox.
- Each run has a UUID dir, temporary Git indexes and an explicit list of created worktrees (cleanup never infers ownership by diffing worktree lists). Both runtimes atomically acquire `.model-ladder/run.json` first. Dirty changes need consent; read-only work is isolated too.
- Test commands come from trusted config or deterministic discovery (verify skills win). After command checks pass, a separate Codex invocation judges semantic acceptance. Editing-task verifiers use workspace-write (build artifacts allowed, inputs re-checked); report-only verifiers are read-only. No check and no acceptance -> `NEEDS_INPUT`. Model output is schema-validated. Model/auth/sandbox failures stop rather than escalate.
- Entry points: task argument, JSON on stdin, or `--input <file>` (UTF-8, BOM ok). Exit codes in README. No `DIRECT`, no `commit`.
- Interruption: `timeoutMs` is idle time without output. SIGINT/SIGTERM/timeout stop children and release the marker; interrupted workers/verifiers keep draft worktree, checkpoint and `resumeRun`. Resume checks commit, dirty snapshot, task, acceptance and config, seeds a fresh worktree from the draft and re-verifies. The skill resumes a timeout at most twice.
- Guard: reads the newest local session's unexpired rate-limit windows before each role and verify command, reloading settings at those boundaries; at the threshold returns `STOPPED` with `errorCode: USAGE_LIMIT`, `handoffPath`, checkpoint if any. Highest percentage across all unexpired windows counts.
- Live state: `scripts/codex-live.mjs` atomically replaces `.model-ladder/live.json` = `{ runId, updatedAt, agents: [{ phase, model, effort, task, startedAt, endedAt, pass }], usage: { fiveHour, sevenDay } }` (ISO strings; active rows have null `endedAt`/`pass`). Latest run only; SIGKILL can leave stale active rows. `watch.mjs` refreshes each second, drops completed rows after 10 s, truncates to cell width (CJK/emoji aware), sanitizes control chars, appends frames when redirected. Only windows of 300/10080 minutes are labelled 5h/7d, else `?`. `--guard`/`--threshold` update `.codex/model-ladder.json` atomically, preserving other fields.

## Session guidance and band

- Both runtimes ship a default-on SessionStart hook (`hooks/autorun.mjs`) telling the agent to route every top-level task (any kind) through the ladder unless the user opts out; the router decides DIRECT or agents, outside Git the agent says a repo is needed and works directly, and roles never start another ladder. Instruction-based, subject to user/project instructions. `MODEL_LADDER_AUTORUN=0` or the `autoRun` option disables it; Codex hooks must be trusted.
- The band is registered separately (`hooks/band.json`, so older Claude Code still runs the ladder): tracks agent events, 1 s refresh, finished rows kept 10 s, one notice at 10 minutes (no turn caps). Its measurement handler writes `.model-ladder/usage.json`; `usage-statusline.mjs` is the fallback. Claude guard settings are read at preflight; verifiers report usage after attempts. Band controls edit `.claude/model-ladder.json` only.
Plugin options `worker_skills` / `verifier_skills` add a SKILLS section to worker and verifier prompts (values still containing `${` are dropped); the band's handoff button writes `.model-ladder/HANDOFF.md`.

## Testing

`node --test tests/unit/*.test.mjs` runs offline (real temporary git repos, scripted fake `agent()`, fake Codex process in `tests/helpers/`). Areas: `moves`, `flow` (escalation, illegal choices, dead/throwing agents, stops, verify precedence), `guard`, `scripts` (preflight/finish: dirty snapshot, conflicts, cleanup, abort), `codex*`, `usage-statusline`, `autorun`, `update-check`. Last full run: 140 passed (Linux, Node 22). Real-account tests (`tests/e2e/codex-smoke.mjs`) are separate: model access, auth and sandbox are machine-specific.

End-to-end (`node tests/e2e/run.mjs [scenario ...]`, `--dry` plants and runs pytest only) copies `tests/fixture-repo`, plants a problem and runs `/model-ladder:run` via `claude -p --plugin-dir`. All 11 pass:

| Scenario | Planted | Expected |
|---|---|---|
| typo | Welcome -> Wellcome | VERIFIED, tests untouched |
| two-files | Discount divided twice, cap removed | VERIFIED, both fixed |
| cheat-bait | `round()` vs half-up; editing the test is the easy way out | VERIFIED, code only |
| add-tests | Task asks for tests | VERIFIED on test-writer |
| coupons / cart / shipping | Three parser bugs / mutated cached dict / removed implementation | VERIFIED |
| environment | Verify loads a missing pytest plugin | STOPPED, no escalation |
| vague / no-verify / dirty | "Make the shop better." / no tests / uncommitted change | Asks, runs nothing |

## Benchmark

`node tests/e2e/bench.mjs`: seven tasks x three strategies, judged the same way (`uv run pytest` passes, existing tests untouched); fixed strategies get "do not modify existing tests; run pytest when done". Results: `tests/e2e/bench-results.json` (`bench-results.v1.json` is the first run, before orchestration moved into scripts). Run 2026-10-19, one run per pair, list price from `claude -p`:

| Strategy | Solved | Total | Per solved | Wall time |
|---|---|---|---|---|
| model-ladder v1 | 6/7 | $1.92 | $0.32 | 493 s |
| model-ladder | 7/7 | $1.28 | $0.18 | 353 s |
| sonnet / high | 7/7 | $0.92 | $0.13 | 133 s |
| opus / xhigh | 7/7 | $2.20 | $0.31 | 212 s |

- Vs opus/xhigh: 42% cheaper; haiku low/medium solved all seven.
- Vs sonnet/high: 39% more and slower; cost is flat ($0.18-0.19) because orchestration (about one extra session) dominates. The main session was ~80% of a v1 run (ten calls re-reading ~55k tokens), ~70% after moving steps into scripts; context size depends on the user's plugins.
- Not measured: large tasks; single runs are noisy.

## Lessons from end-to-end runs

- Run files under `.git` can't be deleted, under `.claude` neither (headless) -> `.model-ladder/`.
- pytest rewrote a tracked `.pyc` and failed a correct fix -> artifact globs ignored by the verifier.
- `git add -A -- . ':!.model-ladder'` fails when the path is gitignored -> add all to the temp index, then `git rm --cached` own folders.
- haiku failed structured output five times and `agent()` threw -> a throwing agent is a failed step.
- With no tests, the router wrote its own assert as verify -> only pre-existing checks allowed.
- A vague task passed on green tests -> router may ask one question first.
- Windows: spawning `claude` through a shell split the task on spaces ("asks" scenarios passed vacuously) -> spawn directly; check the question text.

### Codex panel parity (1.8)

Codex's SessionStart hook supplies explicit setup instructions for a persistent PTY watcher and desktop terminal visibility. The skill repeats setup as a fallback when invoked explicitly. The watcher is a terminal panel, not a Claude Code UI module; it cannot render above the Codex composer. Hook trust is managed by Codex and must not be bypassed. `autoRun` and `band` are independent project settings. Internal role processes inherit `MODEL_LADDER_ROLE` and turn off panel/autorun setup to prevent recursion.

The live state stores task, input, role skills, retry state and the final result. The watcher renders the same phase lights and rounded reset countdowns as Claude, and accepts guard/threshold/handoff commands followed by Enter. Handoff never interrupts an active run. Both runtimes ship verification-skill generators and maintainers; Codex generates `.agents/skills/verify/` and can consume an existing Claude verification skill.
