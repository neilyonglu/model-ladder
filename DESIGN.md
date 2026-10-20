# model-ladder — Design

A Claude Code plugin that runs a coding task on the cheapest model and effort likely to succeed, verifies the result, and escalates on failure. A router model picks the starting point and diagnoses each failure; code enforces the escalation rules.

Status: v0.1 implemented. 45 unit tests, 11 end-to-end scenarios and a 21-run benchmark pass (see [Testing](#testing)).

## Goals

- Spend less per verified task than running everything on a strong model at high effort.
- Never report a task as done without a verification signal.
- Never leave the user's branch half-finished or touch their uncommitted work.
- Install with two commands; no proxy, no API keys, works on a Claude subscription.

Non-goals for v1: other agents (Codex, Gemini), parallel attempts (best-of-N), cost in dollars.

## Repository layout

```text
model-ladder/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/run/SKILL.md        # entry point: preflight script, one workflow call, finish script
├── workflows/ladder.js        # route, then the attempt loop
├── agents/
│   ├── router.md              # read-only: start cell, diagnosis
│   ├── worker.md              # implements one brief; tests protected
│   ├── test-writer.md         # implements one brief whose task is tests
│   └── verifier.md            # checks an attempt, never edits
├── scripts/
│   ├── preflight.mjs          # config, dirty snapshot, run marker, workflow args
│   ├── finish.mjs             # apply, commit, cleanup, history, report
│   └── common.mjs
├── hooks/
│   ├── hooks.json             # PreToolUse on Edit|Write|MultiEdit|NotebookEdit
│   └── guard.mjs              # blocks protected paths during a run
└── tests/
    ├── unit/                  # node --test
    ├── fixture-repo/          # uv project, green; scenarios plant problems into copies
    └── e2e/                   # run.mjs (scenarios), bench.mjs (strategy comparison)
```

## Roles

| Role | Model / effort | Tools | Job |
|---|---|---|---|
| Skill (main session) | sonnet / medium (skill frontmatter) | all | Run the two scripts and the workflow; ask the user when a script or the workflow needs a decision |
| Router | `router`, default sonnet / low | Read, Grep, Glob | Pick the start cell; diagnose each failure; explain a final failure |
| Worker / test-writer | the current ladder cell | Read, Grep, Glob, Edit, Write, Bash | Implement the brief in a fresh worktree |
| Verifier | `verifier` (haiku / low) with a verify command, else `router` | Read, Grep, Glob, Bash | Check protected paths, run verify or judge acceptance |

The orchestrating session is pinned to sonnet/medium: its steps are mechanical, while every judgment call sits with the router. It is not pinned lower because it runs `git apply` and worktree removal on the user's repository.

Running a verify command needs no judgment, so a cheap verifier does it. Judging acceptance criteria without a command does, so that falls back to the router's model.

## Configuration

Project only: `.claude/model-ladder.json`. Every project differs, so there is no global file. Each top-level key replaces its default.

```json
{
  "router":   { "model": "sonnet", "effort": "low" },
  "verifier": { "model": "haiku",  "effort": "low" },
  "tiers": [
    { "model": "haiku",  "efforts": ["low", "medium", "high"],          "maxEffortJump": 2 },
    { "model": "sonnet", "efforts": ["low", "medium", "high"],          "maxEffortJump": 2 },
    { "model": "opus",   "efforts": ["low", "medium", "high", "xhigh"], "maxEffortJump": 1 }
  ],
  "maxAttempts": 4,
  "verify": null,
  "protected": [],
  "commit": false,
  "keepFailed": false
}
```

- Models are aliases, not IDs, so new model versions are picked up without a release.
- `tiers` is ordered weakest to strongest.
- `verify`: shell command that proves the task is done.
- `protected`: extra globs no worker may modify, on top of the built-in ones.
- `commit`: commit the applied diff on the user's branch.
- `keepFailed`: keep worktrees of failed attempts for debugging.

`preflight.mjs` validates the merged config and stops with a message naming each problem.

## The grid and legal moves

The ladder is a grid of cells `(tier, effort)`. A move is legal when it goes up:

| Move | Rule |
|---|---|
| Same tier, higher effort | Up to `maxEffortJump` effort steps |
| Next tier | Only `tier + 1`; any effort in that tier |
| Down, sideways, or skipping a tier | Never |

Changing tier may land on a lower effort (sonnet/high → opus/low). A tier change usually means a knowledge or capability gap, which a stronger model often fixes at low effort.

`legalMoves(cell, tiers)` is a pure function. The workflow computes the legal list and hands it to the router, so the router answers a multiple-choice question instead of applying rules from memory. An illegal or malformed answer falls back to the default move: next effort in the same tier, else the lowest effort of the next tier.

## Flow

```text
Skill (main session)
  0. ladder or direct               → small task in a large session: do it directly, stop
  1. node scripts/preflight.mjs     → READY + workflowArgs, or a status that needs the user
  2. Workflow model-ladder:ladder   → route, then attempts → VERIFIED | FAILED | STOPPED
                                       (or NEEDS_INPUT: ask, call again)
  3. node scripts/finish.mjs        → apply, cleanup, history, report text
```

Everything deterministic lives in the scripts, so the main session makes about five model calls per run whatever the task. Workflow scripts cannot touch the filesystem, which is why file work sits outside the workflow.

### 0. Ladder or direct (provisional)

The orchestration runs in the calling session, so each of its model calls re-reads that session's whole context. Its cost is not fixed: it grows with the caller's context. In a long session (2026-10-20, a forge session past 400k tokens) one orchestration turn can cost more than a whole worker attempt, and a small task leaves little for a cheaper worker to save.

So `/model-ladder:run` first checks two things and skips the ladder when both hold:

| | Small context | Large context (above ~150k tokens) |
|---|---|---|
| Small task (one or two files, design given) | ladder | direct |
| Larger task | ladder | ladder |

`--ladder` at the start of the task forces the ladder. The skill cannot read its own token count, so the model estimates it; the thresholds are a starting guess, not a measurement.

To calibrate later:

1. Record the main session's orchestration cost in `history.jsonl`; today it holds only route and attempt output tokens.
2. Run the same tasks through the ladder from a fresh session and from a long one, and directly with sonnet/high and opus.
3. Group tasks by size (files changed, output tokens) and find where the ladder and direct lines cross for each context size.

### 1. Preflight

Returns the first thing the user must decide as a status; the skill asks and reruns with the granted flag.

| Status | Meaning | Flag on yes |
|---|---|---|
| `ERROR` | Not a git repo with a commit, or invalid config | — |
| `STALE_RUN` | A run marker exists: another run is active or one crashed | `--clear-stale` |
| `OVERRIDDEN` | `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set; either overrides every attempt's cell | `--ignore-env` |
| `DIRTY` | Uncommitted changes, listed | `--allow-dirty` |
| `READY` | `workflowArgs`: config, protection, `hasVerifySkill`, setup patch and files | — |

On a dirty run, preflight snapshots the changes through a temporary index (`GIT_INDEX_FILE`) so the user's real index is untouched:

- `baseTree`: `git write-tree` of HEAD plus the uncommitted changes, untracked files included.
- `setup.patch`: `git diff --cached --binary HEAD`, which the worker applies first.
- `setupFiles`: the files in that patch. The verifier exempts them from the protected check, so the user's own test edits do not fail an attempt.

On a clean tree `baseTree` is `HEAD^{tree}`. Preflight also records the existing worktrees and writes the run marker.

All run files live in `<repo root>/.model-ladder/`: `run.json` (the marker), `state.json`, `setup.patch`, `result.patch`, `history.jsonl`. Not under `.git` or `.claude`: Claude Code asks permission to delete files under `.git` and to edit or delete files under `.claude`, which in headless runs left stale markers and dropped history lines.

### 2. Workflow

One call routes and runs. It returns early with `NEEDS_INPUT` only when the user must answer first; the skill then calls again, with the plan (criteria filled in) or with a clarified task.

**Route.** The router reads the task and the repo and returns the start cell with a reason, a one-sentence goal, the expected scope, the verify step, acceptance criteria, `allowTests` with a reason, and an optional question.

Verify source, first match wins:

1. `verify` in the config file.
2. A project verify skill at `.claude/skills/verify/` (for example one generated by pstack's create-verification-skill).
3. An existing test suite the router finds in the repo. The router may not write a check of its own, not even a one-line assert: that would let it, not the user, define done.
4. None: `needsAcceptance`. The user confirms the router's proposed criteria or gives their own.

`question` is set when the task is too vague to act on. Without it, a vague task such as "make the shop better" would pass: the worker changes something and the existing tests stay green.

**Attempts.**

```text
cell = start; history = []
for attempt in 1..maxAttempts:
    w = worker(brief(cell, history, hint))         # cell's model/effort, isolation: worktree
    v = verifier(w.worktreePath)                   # skipped when w died, blocked or changed nothing
    history.push({cell, w, v, tokens})
    if v.pass: return VERIFIED
    if attempt == maxAttempts or legalMoves(cell) is empty: break
    d = router.diagnose(history, legalMoves(cell))
    if d.action starts with "stop_": return STOPPED
    cell = d.choice if legal else defaultMove(cell)
    hint = d.hint
final = router.explain(history)                    # why it failed, what the user can do
return FAILED
```

- Each attempt starts from a clean worktree at the base commit. A weak model's broken patch tends to mislead the next one, so failures carry forward as summaries and hints, not as code.
- `agent()` returns null when an agent dies and throws when it cannot produce valid structured output. Both count as a failed step: a failed worker is a failed attempt, a failed diagnosis takes the default move. Only a failed route stops the run.
- The router sees the latest attempt in full (verify output trimmed to the last 200 lines) and earlier attempts as summaries.
- Worst case: 1 route + 4 × (worker, verifier, diagnose) + 1 final explanation = 14 agent calls.
- The workflow returns a compact result (no verify output, no hints) because the main session copies it into the finish script.

| Diagnosis | Meaning | Workflow |
|---|---|---|
| `raise_effort` | Right direction, not deep enough | Higher effort in the same tier |
| `raise_model` | Knowledge or capability gap, including invalid output | Next tier |
| `stop_environment` | Missing dependency, broken test setup, unreachable service | Stop; a stronger model will not help |
| `stop_unclear` | The task is ambiguous; the worker is guessing | Stop |

### 3. Finish

Reads the workflow result (or an abort reason, or the workflow's error) on stdin. Always:

- On VERIFIED, stage everything in the winning worktree, `git write-tree` it, and apply `git diff --binary baseTree resultTree` to the user's working tree. Diffing against `baseTree` instead of HEAD keeps the user's own uncommitted changes out of the patch. Both trees live in the shared object store.
- If `commit` is true, commit only the patch's files as `model-ladder: <goal>`.
- If the patch does not apply (the user edited the same files during the run), keep the winning worktree and `result.patch` and say where they are.
- Remove the worktrees and `worktree-wf_*` branches the run created, except failed ones when `keepFailed` is true.
- Delete the run marker, state and setup patch, so an abort or crash never leaves the guard armed.
- Append a history line and print the report.

## Briefs and agents

Brief:

```text
GOAL         one sentence                              router
TASK         as the user wrote it                      user
SCOPE        files expected to change                  router
ACCEPTANCE   one checkable criterion per line          user, else router
VERIFY       command, or "check ACCEPTANCE"            config / verify skill / router
FORBIDDEN    protected globs, no commits               preflight + router (allowTests)
SETUP        git apply <patch>  (dirty runs only)      preflight
PREVIOUS     one line per failed attempt               workflow (attempt 2+)
HINT         latest diagnosis                          router (attempt 2+)
REPORT       worktreePath via git rev-parse            plugin
```

The brief format is adapted from pstack's orchestrate playbook (MIT).

A task whose point is writing tests runs on `test-writer`, every other task on `worker`. The two differ only in whether test files are protected. Splitting them lets the hook tell the cases apart by `agent_type`, so the run marker can be written once, before the router has decided `allowTests`.

`status: "blocked"` means the worker judged the task impossible as specified. It counts as a failure and goes to diagnosis.

## Protected paths

```text
tests (worker only)   **/test_*.py  **/*_test.py  **/tests/**  **/__tests__/**
                      **/*.test.*   **/*.spec.*   **/src/test/**
always                .claude/model-ladder.json, plus config "protected"
```

The ladder config is always protected: a worker could otherwise pass by rewriting the verify command.

Two layers:

1. **Hook (early, best effort).** `guard.mjs` on PreToolUse. It blocks only when the caller is a model-ladder worker or test-writer, the run marker exists, and the path matches. Exit 2 tells the worker at once, so the attempt is not wasted. If Node is missing or the script errors, the exit code is not 2 and Claude Code continues: the hook fails open. Outside a run the marker is absent, so the user's own edits are never blocked.
2. **Verifier diff check (always).** `git status --porcelain --untracked-files=all` in the worktree against the same globs. Catches edits made through Bash and anything the hook missed. It ignores build artifacts the verify step itself rewrites (`__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules`, `target`, `build`, `dist`, `coverage`).

## Report and history

```text
model-ladder ── VERIFIED

Task      Order totals are wrong when a coupon is used. Fix the pricing code.
Verify    uv run pytest
Tests     protected (router: bug fix; the tests define the expected behavior)
Start     haiku/medium (router: two small files, arithmetic bug)

#  Model / Effort   Result   Why next
1  haiku / medium   PASS     —

Changed   shop/discount.py, shop/pricing.py
Applied   to the working tree (not committed)
Tokens    6772 output (route + attempts)
```

FAILED and STOPPED reports end with the router's explanation and suggestion.

Tokens are output tokens per agent call, the change in `budget.spent()` around each call. Input tokens, the main session and dollar cost are not available inside the workflow.

History: one JSON line per run in `.model-ladder/history.jsonl` (task, status, start, attempts with cell, result, reason, action and tokens, applied, committed). It is what tells a project whether its ladder is tuned well.

## Releases and updates

Claude Code offers a plugin update only when `version` in `.claude-plugin/plugin.json` changes; new commits under the same version reach no one. Third-party marketplaces do not auto-update unless the user enables it, and Claude Code does not announce a pending update. So:

- **The report announces new versions.** `scripts/update-check.mjs` reads the published `plugin.json` from GitHub at most once a day (cached in the OS temp folder), and finish appends one line with the update command when it is newer. Any failure is silent; `MODEL_LADDER_NO_UPDATE_CHECK=1` turns it off. Nothing about the user or the task is sent.
- **CI blocks a forgotten bump.** `.github/scripts/check-version.mjs` fails when files under `.claude-plugin`, `skills`, `agents`, `hooks`, `scripts` or `workflows` changed since the latest `v*` tag while the version did not move past it.
- **Each release** bumps the version, adds a `CHANGELOG.md` entry, and gets a `vX.Y.Z` tag and a GitHub Release, which notifies watchers.

## Testing

### Unit tests

`node --test "tests/unit/*.test.mjs"` (45 tests, no dependencies):

- `moves`: legal moves per tier, jump caps, tier changes, top cell, fallbacks, protection lists.
- `flow`: the workflow body run against a scripted fake `agent()`: escalation paths, illegal choices, dead, blocked and throwing agents, stops, verifier model choice, worker type, `NEEDS_INPUT`, verify precedence.
- `guard`: patterns, marker found from a linked worktree, worker vs test-writer vs other agents.
- `scripts`: preflight and finish against real temporary git repos: config merge and validation, stale marker, dirty snapshot with the real index untouched, applying only the worker's change, commit of patch files only, conflicting apply, cleanup, keepFailed, abort and crash.

### Spikes

Run 2026-10-19 on Windows 11, Claude Code 2.1.296, Node 24, with a throwaway plugin loaded through `claude -p --plugin-dir`. All held.

| # | Check | Result |
|---|---|---|
| 1 | `agent()` with `effort` reaches haiku | The hook input showed `effort.level` per call; haiku/high spent 763 output tokens against 502 for haiku/low on the same puzzle |
| 2 | A skill can invoke the plugin workflow with `args` | Workflow name is `<plugin>:<workflow>`; `args` arrives as an object |
| 3 | Worktree isolation branches from HEAD | `<repo>/.claude/worktrees/wf_*` on branch `worktree-wf_*`, sharing the main `.git` |
| 4 | PreToolUse input carries `agent_type` inside subagents | Also `agent_id`, `effort.level` and `cwd` (the worktree) |
| 5 | Hook commands run `node` on Windows | Exit 2 blocked the Write; the worker did not try to bypass it |
| 6 | `budget.spent()` works with no budget set | `budget.total` is null and `spent()` still counts |
| 7 | `CLAUDE_CODE_EFFORT_LEVEL` overrides per-call effort | A call asking for high ran at low |
| 8 | Plugin skills can locate plugin files | `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}` are substituted in skill content |

### End-to-end scenarios

`node tests/e2e/run.mjs [scenario ...]` copies the fixture, plants a problem, runs `/model-ladder:run` headlessly with `claude -p --plugin-dir`, and checks the outcome. `--dry` only plants and runs pytest. All 11 pass:

| Scenario | Planted | Expected |
|---|---|---|
| typo | Welcome → Wellcome | VERIFIED, tests untouched |
| two-files | Discount divided twice and its cap removed | VERIFIED, both files fixed |
| cheat-bait | `round()` instead of half-up rounding; editing the test is the easy way out | VERIFIED, only code changed |
| add-tests | Task asks for tests | VERIFIED on test-writer, new tests |
| coupons | Three bugs in one parser | VERIFIED |
| cart | A cached dict mutated by member checkout | VERIFIED |
| shipping | Implementation removed; rules in `docs/shipping.md` | VERIFIED |
| environment | Verify command loads a missing pytest plugin | STOPPED, no escalation |
| vague | "Make the shop better." | Asks a question, runs nothing |
| no-verify | No tests in the repo | Asks for done criteria, runs nothing |
| dirty | Uncommitted change | Asks, runs nothing, change intact |

Headless runs cannot answer questions, so "asks" scenarios check the question text and that nothing ran.

### Benchmark

`node tests/e2e/bench.mjs` runs seven tasks under three strategies and judges all of them the same way: `uv run pytest` passes afterwards and existing tests are untouched. The fixed strategies get the task plus "do not modify existing tests; run pytest when done". Results are in `tests/e2e/bench-results.json`; `bench-results.v1.json` holds the first model-ladder run, before the orchestration was moved into scripts.

Run 2026-10-19, one run per pair, list-price cost as reported by `claude -p`:

| Strategy | Solved | Total | Per solved | Wall time |
|---|---|---|---|---|
| model-ladder v1 | 6/7 | $1.92 | $0.32 | 493 s |
| model-ladder | 7/7 | $1.28 | $0.18 | 353 s |
| sonnet / high | 7/7 | $0.92 | $0.13 | 133 s |
| opus / xhigh | 7/7 | $2.20 | $0.31 | 212 s |

Reading it:

- Against opus/xhigh, model-ladder solved the same tasks for 42% less. Haiku at low or medium solved all seven; only one task in the v1 run escalated (haiku/medium → haiku/high).
- Against sonnet/high it costs 39% more and is slower. Its cost barely varies by task ($0.18–0.19): it is dominated by orchestration, which is roughly one extra session per run. On tasks this small, that overhead is larger than what a cheaper worker saves.
- A run's cost split (v1): the main session took about 80%, because every one of its ten model calls re-reads a ~55k-token context. Moving the deterministic steps into scripts cut that to five calls; the main session is still about 70% of a run. That context size depends on the user's installed plugins and skills.
- Not measured: large tasks, where a fixed sonnet or opus run costs dollars and the orchestration overhead would be a small share. Single runs per pair are noisy.

### Lessons from end-to-end runs

Each of these was found by a real run, not by the unit tests:

- Run files under `.git` could be written but not deleted; under `.claude` neither, in headless mode. → `.model-ladder/`.
- pytest rewrote a tracked `.pyc` under `tests/`, which failed a correct fix as "modified protected file". → artifact globs ignored by the verifier.
- `git add -A -- . ':!.model-ladder'` fails when the excluded path is gitignored. → add everything to the temporary index, then `git rm --cached` model-ladder's own folders.
- haiku once failed to produce valid structured output five times; `agent()` threw and the whole run stopped. → a throwing agent is a failed step.
- With no tests in the repo, the router wrote its own one-line assert as the verify step. → the router may only use checks that already exist.
- A vague task passed because the existing tests stayed green. → the router can ask one question before any work.
- On Windows, spawning `claude` through a shell split the task on spaces, so every run got an empty task, and "asks" scenarios passed vacuously. → spawn the executable directly; "asks" scenarios check the question.

## Credits

The brief format and the "verifier on a fresh context" rule are adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (MIT).
