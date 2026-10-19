# model-ladder — Design

A Claude Code plugin that runs a coding task on the cheapest model and effort likely to succeed, verifies the result, and escalates on failure. A router model picks the starting point and diagnoses each failure. Code enforces the escalation rules.

Status: design agreed, spikes passed (see [Spikes](#spikes)).

## Goals

- Spend fewer tokens per verified task than running everything on a strong model at high effort.
- Never report a task as done without a verification signal.
- Never leave the user's branch in a half-finished state.
- Install with two commands; no proxy, no API keys, works on a Claude subscription.

Non-goals for v1: other agents (Codex, Gemini), parallel attempts (best-of-N), cost in dollars.

## Repository layout

```text
model-ladder/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/run/SKILL.md        # entry point: preflight, two workflow calls, apply, report
├── workflows/ladder.js        # route mode + run mode
├── agents/
│   ├── router.md              # read-only: start cell, diagnosis
│   ├── worker.md              # implements one brief
│   └── verifier.md            # checks an attempt, never edits
├── hooks/
│   ├── hooks.json             # PreToolUse on Edit|Write|MultiEdit|NotebookEdit
│   └── guard.mjs              # blocks protected paths during a run
├── tests/
│   ├── unit/                  # node --test: legalMoves, guard
│   └── fixture-repo/          # uv project with planted scenarios
├── DESIGN.md
├── README.md
└── LICENSE                    # MIT
```

Install:

```text
/plugin marketplace add neilyonglu/model-ladder
/plugin install model-ladder@model-ladder
```

## Roles

| Role | Model / effort | Tools | Job |
|---|---|---|---|
| Skill (main session) | session model | all | Preflight, call the workflow, apply the diff, write history, report |
| Router | sonnet / low | Read, Grep, Glob | Pick the start cell; diagnose each failure |
| Worker | per ladder cell | Read, Grep, Glob, Edit, Write, Bash | Implement the brief in a fresh worktree |
| Verifier | sonnet / low | Read, Grep, Glob, Bash | Check protected paths, run verify, judge acceptance |

The verifier always runs on sonnet/low. When the worker is also sonnet, the verifier still starts from a fresh context and, when a verify command exists, judges the command's result rather than its own opinion. Without a verify command it judges acceptance criteria and is told to be strict.

## Configuration

Project only: `.claude/model-ladder.json`. Every project differs, so there is no global file. All fields are optional; defaults below.

```json
{
  "router": { "model": "sonnet", "effort": "low" },
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
- `protected`: extra glob patterns the worker may not modify, added to the built-in test patterns.
- `commit`: commit the applied diff on the user's branch.
- `keepFailed`: keep worktrees of failed attempts for debugging.

## The grid and legal moves

The ladder is a grid of cells `(tier, effort)`. A move is legal when it goes up:

| Move | Rule |
|---|---|
| Same tier, higher effort | Up to `maxEffortJump` effort steps |
| Next tier | Only `tier + 1`; any effort in that tier |
| Down, sideways, or skipping a tier | Never |

Changing tier may land on a lower effort (sonnet/high → opus/low). The router must give a reason. A tier change usually means a knowledge or capability gap, which a stronger model often fixes at low effort.

`legalMoves(cell, config)` is a pure function. The workflow computes the legal list and hands it to the router, so the router answers a multiple-choice question instead of applying rules from memory. An illegal or malformed router answer falls back to the default move: next effort in the same tier, else the lowest effort of the next tier.

## Flow

```text
Skill
  1. Preflight
  2. Workflow(mode: "route")  → start cell, verify, acceptance, allowTests, reasons
  3. Write the run marker
  4. Workflow(mode: "run")    → VERIFIED | FAILED | STOPPED, attempts, winning worktree
  5. Apply, commit (optional), clean up, append history, delete the run marker
  6. Report
```

The workflow cannot touch the filesystem, so file work lives in the skill. Routing is a separate workflow call because its decision (`allowTests`) has to reach the run marker before any worker starts.

### 1. Preflight (skill)

- Read `.claude/model-ladder.json` and merge it over the defaults.
- Warn when `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set; either one overrides the ladder.
- If the working tree is dirty, stop and ask whether to run on top of the uncommitted changes. On no, stop. On yes, snapshot them through a temporary index (`GIT_INDEX_FILE`), so the user's real index is untouched:
  - `BASE_TREE`: `git write-tree` of HEAD plus the uncommitted changes, untracked files included.
  - Setup patch: `git diff --cached --binary HEAD`, which the worker applies first.
  - `setupFiles`: the files in that patch. The verifier exempts them from the protected check, so the user's own test edits do not fail an attempt.
- On a clean tree, `BASE_TREE` is `HEAD^{tree}` and there is no setup patch.
- Record `git worktree list` so cleanup can tell which worktrees this run created.

### 2. Route (workflow, mode "route")

The router reads the task and the repo and returns:

```json
{
  "model": "sonnet",
  "effort": "medium",
  "reason": "Touches 3 files in the parser; needs cross-file reasoning",
  "goal": "Make parse_date honor the UTC offset",
  "scope": ["src/parser.py", "src/dates.py"],
  "verify": "uv run pytest tests/test_parser.py",
  "acceptance": ["tests/test_parser.py passes"],
  "allowTests": false,
  "allowTestsReason": "Bug fix; tests define the expected behavior"
}
```

Verify source, first match wins:

1. `verify` in the config file.
2. A project verify skill at `.claude/skills/verify/` (for example one generated by pstack's create-verification-skill).
3. The router's inference from the repo (`pyproject.toml` → pytest, `package.json` → test script, …).
4. None: the skill asks the user to define what "done" means. The answers become `acceptance`.

### 3. Run marker (skill)

Written to `<repo root>/.model-ladder/run.json`, next to the setup and result patches. From inside a worktree the hook finds it as the parent of `git rev-parse --git-common-dir`, plus that path. Run files stay out of `.git` and `.claude`: end-to-end runs showed Claude Code asks permission to delete files under `.git` and to edit or delete files under `.claude`, which leaves stale markers and drops history lines in headless runs.

The verifier's protected check ignores build artifacts that running the verify step rewrites (`__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules`, `target`, `build`, `dist`, `coverage`). The first end-to-end run failed a correct fix because pytest rewrote a `.pyc` under `tests/`.

```json
{ "protected": ["**/tests/**", "..."], "allowTests": false }
```

### 4. Run (workflow, mode "run")

```text
cell = start; history = []
for attempt in 1..maxAttempts:
    w = worker(brief(cell, history, hint))         # cell's model/effort, isolation: worktree
    v = verifier(w.worktreePath)
    history.push({cell, w, v, tokens})
    if v.pass: return VERIFIED
    if attempt == maxAttempts or legalMoves(cell) is empty: break
    d = router.diagnose(history, legalMoves(cell))
    if d.action starts with "stop_": return STOPPED
    cell = d.choice if legal else defaultMove(cell)
    hint = d.hint
final = router.diagnose(history, [])                # explains the failure for the report
return FAILED
```

- Each attempt starts from a clean worktree at the base commit. A weak model's broken patch tends to mislead the next one, so failures carry forward as summaries and hints, not as code.
- A worker that dies (`agent()` returns null) counts as a failed attempt.
- The router sees the latest attempt in full (verify output trimmed to the last 200 lines) and earlier attempts as summaries.
- Worst case: 1 route + 4 × (worker, verifier, diagnose) + 1 final diagnose = 14 agent calls.

Diagnosis output:

```json
{
  "action": "raise_model",
  "model": "opus",
  "effort": "low",
  "reason": "Worker misuses the asyncpg API twice; knowledge gap, not depth",
  "hint": "Acquire the connection with 'async with pool.acquire()'"
}
```

| Action | Meaning | Workflow |
|---|---|---|
| `raise_effort` | Right direction, not deep enough | Move to a higher effort in the same tier |
| `raise_model` | Knowledge or capability gap | Move to the next tier |
| `stop_environment` | Missing dependency, broken test setup, unreachable service | Stop; a stronger model will not help |
| `stop_unclear` | The task is ambiguous; the worker is guessing | Stop; ask the user |

### 5. Apply (skill)

- On VERIFIED, stage everything in the winning worktree, `git write-tree` it, and apply `git diff --binary BASE_TREE RESULT_TREE` to the user's working tree without asking. Diffing against `BASE_TREE` instead of HEAD leaves out the user's own uncommitted changes, which the worker started from. Both trees live in the shared object store.
- If `commit` is true, stage only the patch's files and commit them as `model-ladder: <goal>`.
- If the apply conflicts (the user edited the same files during the run), do not apply. Keep the winning worktree and the patch file and tell the user where they are.
- Remove the run's worktrees and their `worktree-wf_*` branches, except failed ones when `keepFailed` is true.
- If `route` returns `needsAcceptance` (no verify step and no criteria), the skill asks the user how to tell the task is done before running.

## Worker

`agents/worker.md` sets tools and `maxTurns: 60`. Model and effort come from each workflow call. The router (`agents/router.md`, read-only) and the verifier (`agents/verifier.md`, no Edit or Write) get their own definitions so their tools are restricted.

Brief:

```text
GOAL         one sentence                              router
SCOPE        files expected to change                  router
ACCEPTANCE   one checkable criterion per line          user, else router
VERIFY       command, or "check ACCEPTANCE"            config / verify skill / router
FORBIDDEN    protected paths, no commits               plugin + config
SETUP        git apply <patch>  (dirty runs only)      skill
HINT         latest diagnosis, prior attempts summary  router (attempt 2+)
REPORT       schema below                              plugin
```

The brief format is adapted from pstack's orchestrate playbook (MIT).

Report:

```json
{
  "status": "done",
  "worktreePath": "C:/…/.claude/worktrees/wf_abc",
  "filesChanged": ["src/parser.py"],
  "summary": "Fixed timezone offset in parse_date",
  "selfCheck": "ran pytest tests/test_parser.py: 12 passed",
  "blockedReason": null
}
```

`status: "blocked"` means the worker judged the task impossible at its level. It counts as a failure and goes to diagnosis.

## Verifier

In the worker's worktree, in order:

1. Dirty runs: confirm the setup patch is applied.
2. `git diff --name-only` against protected patterns. Built-in patterns are skipped when `allowTests` is true; `protected` from config always applies. A hit fails the attempt with `modified protected file <path>`.
3. Run the verify command, or judge each acceptance criterion against the diff.

Output: `{ "pass": bool, "reason": string, "output": string }`, where `output` is the last 200 lines of the verify run.

## Protected paths

Built-in patterns:

```text
**/test_*.py   **/*_test.py   **/tests/**   **/__tests__/**
**/*.test.*    **/*.spec.*    **/src/test/**
```

Two layers:

1. **Hook (early, best effort).** `guard.mjs` on PreToolUse for Edit, Write, MultiEdit and NotebookEdit. It allows the call unless all hold: `agent_type` is `model-ladder:worker`, the run marker exists, and the path matches a protected pattern. A match exits 2, so the worker learns immediately and does not waste the attempt. If Node is missing or the script errors, the exit code is not 2 and Claude Code continues, so the hook fails open.
2. **Verifier diff check (always).** Catches edits made through Bash and anything the hook missed.

Outside a run the marker is absent, so the hook never blocks the user's own edits.

## Report and history

```text
model-ladder ── VERIFIED

Task      Fix failing geography tests
Verify    uv run pytest tests/test_geography.py
Tests     protected (router: task is a bug fix)

#  Model / Effort   Result   Why next
1  haiku / medium   FAIL     raise_effort: missed the null-region edge case
2  haiku / high     FAIL     raise_model: misuses the sqlite3 row factory
3  sonnet / low     PASS     —

Changed   src/geography/regions.py, src/geography/loader.py
Applied   to branch feature-x (not committed)
Tokens    18.4k output
```

FAILED and STOPPED reports end with the final diagnosis: why it failed and what the user can do.

Tokens are output tokens per agent call, measured as the change in `budget.spent()` around each call. Input tokens and dollar cost are not available.

History is on by default: one JSON line per run appended to `.model-ladder/history.jsonl` (task, status, attempts with cell, result, reason and tokens, total tokens, date). The README recommends adding it to `.gitignore`. The history is what tells a project whether its ladder is tuned well.

## Testing

### Spikes

Run 2026-10-19 on Windows 11, Claude Code 2.1.296, Node 24, with a throwaway plugin loaded through `claude -p --plugin-dir` in a scratch repo. All seven held.

| # | Check | Result |
|---|---|---|
| 1 | `agent()` with `effort` reaches haiku | Held. The hook input showed `effort.level` low and high per call; haiku/high spent 763 output tokens against 502 for haiku/low on the same puzzle |
| 2 | A skill can invoke the plugin workflow and pass `args` | Held. Workflow name is `<plugin>:<workflow>`; `args` arrives as an object |
| 3 | Worktree isolation branches from HEAD | Held. Worktree at `<repo>/.claude/worktrees/wf_*` on branch `worktree-wf_*`, HEAD equal to the base commit, `--git-common-dir` pointing at the main `.git` |
| 4 | PreToolUse input carries `agent_type` inside subagents | Held. Input carries `agent_type` (`<plugin>:worker`), `agent_id`, `effort.level` and `cwd` (the worktree) |
| 5 | Hook commands run `node` on Windows | Held. Exit 2 blocked the Write; the worker saw the stderr message and did not try to bypass it |
| 6 | `budget.spent()` reports tokens with no budget set | Held. `budget.total` is null and `spent()` still counts |
| 7 | `CLAUDE_CODE_EFFORT_LEVEL` overrides per-call effort | Held. With it set to low, the call asking for high ran at low |

Findings that change the implementation:

- `pwd` inside the worker printed a sandbox path (`/tmp/claude/...`), not the worktree. The worker reports `git rev-parse --show-toplevel` as `worktreePath`.
- Worktrees live inside the repo, so the user's `git status` shows `.claude/` as untracked. The README tells users to ignore `.claude/worktrees/` and `.model-ladder/`.
- A worktree with changes survives the run along with its `worktree-wf_*` branch. Cleanup removes both with `git worktree remove` and `git branch -D`.
- `claude -p --plugin-dir <path>` runs the plugin headlessly, which is how the fixture scenarios and the benchmark run.

### Unit tests

`node --test tests/unit`: `legalMoves` (effort jump caps per tier, tier change, top cell, illegal choices fall back) and `guard` (pattern matching, marker present or absent, `allowTests`).

### Fixture repo

`tests/fixture-repo/` is a small uv project (`uv run pytest`) with planted scenarios:

| Scenario | Expected |
|---|---|
| Typo | Low start, VERIFIED in one attempt |
| Bug spanning two files | VERIFIED after at least one escalation |
| Missing dependency | STOPPED (environment), no escalation |
| Ambiguous task | STOPPED (unclear) |
| Bug easiest to "fix" by editing the test | Hook or verifier rejects the test edit; code is fixed |
| "Add tests for X" | `allowTests` true, VERIFIED |
| No verify command | User is asked for acceptance criteria |
| Dirty working tree | Run stops and asks |

### Benchmark

Same fixture tasks, three strategies: fixed sonnet/high, fixed opus/xhigh, model-ladder. Compare verified rate, output tokens, and output tokens per verified task. Results go in the README.

## Credits

The brief format and the "verifier on a fresh context" rule are adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (MIT).
