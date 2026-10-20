# model-ladder

A Claude Code plugin that runs a coding task on the cheapest model and effort likely to succeed, checks the result with your tests, and climbs to a stronger model or a higher effort only when an attempt fails.

```text
/model-ladder:run Order totals are wrong when a coupon is used. Fix the pricing code.
```

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

## Is it worth it for you?

Measured on seven small tasks (typo to "implement this spec"), one run each, list-price cost:

| Strategy | Solved | Cost per solved task |
|---|---|---|
| model-ladder | 7/7 | $0.18 |
| always sonnet / high | 7/7 | $0.13 |
| always opus / xhigh | 7/7 | $0.31 |

- **If you run everything on Opus or a high effort**, model-ladder solved the same tasks for 42% less.
- **If you already run Sonnet on small tasks**, it costs more and is slower. Orchestrating a run costs roughly one extra session, and on small tasks that is more than a cheaper worker saves.
- **Large tasks are not measured yet.** That is where a fixed run costs the most and the overhead matters least.

Details, cost breakdown and caveats: [DESIGN.md › Benchmark](DESIGN.md#benchmark).

## How it works

1. **Route.** A router (sonnet/low, read-only) reads the task and repo and picks a starting cell in a model × effort grid. It also finds your verify step and decides whether the task may touch tests.
2. **Attempt.** A worker on that cell implements the task in a fresh git worktree. Your working tree is not touched.
3. **Verify.** A separate verifier checks that no protected file changed and runs your tests.
4. **Escalate.** On failure, the router diagnoses why and picks the next cell from a list of legal moves: more effort if the worker was on the right track, a stronger model if it lacked knowledge, or stop if the problem is the environment or an unclear task.
5. **Apply.** The verified change lands in your working tree, uncommitted by default.

```text
          low   medium   high   xhigh
haiku      ●      ●       ●
sonnet     ●      ●       ●
opus       ●      ●       ●       ●
```

A move only goes up: higher effort within a model (opus one step at a time), or the next model at any effort. It never skips from haiku to opus.

## Install

```text
/plugin marketplace add neilyonglu/model-ladder
/plugin install model-ladder@model-ladder
```

Requirements:

- Claude Code with the Workflow tool (paid plans; on Pro, enable it in `/config`). Tested on 2.1.296.
- git, and Node.js 18 or later on `PATH`.
- A git repository with at least one commit.

Add these to your `.gitignore`:

```text
.model-ladder/
.claude/worktrees/
```

Each run asks to approve the Workflow call unless you allow it, for example in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Workflow"] } }
```

## Use

```text
/model-ladder:run <task>
```

model-ladder asks before it acts when:

- you have uncommitted changes (it can build on them; they are never part of its patch),
- the task is too vague to act on,
- the repo has no tests for the task: you confirm what "done" means,
- `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, since either overrides every attempt's model or effort.

## Configure

Optional, per project: `.claude/model-ladder.json`. Each key you set replaces its default.

| Key | Default | Meaning |
|---|---|---|
| `router` | `{ "model": "sonnet", "effort": "low" }` | Picks the start, diagnoses failures |
| `verifier` | `{ "model": "haiku", "effort": "low" }` | Runs the verify command (the router's model judges when there is none) |
| `tiers` | haiku low–high, sonnet low–high, opus low–xhigh | The grid, weakest model first; `maxEffortJump` caps effort steps per move (2, 2, 1) |
| `maxAttempts` | `4` | Attempts before giving up |
| `verify` | found by the router | Command that proves the task is done |
| `protected` | `[]` | Extra globs no worker may modify |
| `commit` | `false` | Commit the verified change |
| `keepFailed` | `false` | Keep failed attempts' worktrees for debugging |

Models are aliases (`haiku`, `sonnet`, `opus`), so new model versions are picked up automatically.

Every run appends a line to `.model-ladder/history.jsonl`: which cells were tried, why each move was made, and the tokens spent. Use it to tune the grid, for example to start at haiku/medium if haiku/low keeps failing.

## Safety

- Workers run in throwaway git worktrees. Only a verified change reaches your working tree, and it is never committed unless `commit` is true. Nothing is ever pushed.
- Workers may not touch tests unless the task is about tests, and never the ladder config. A hook blocks such edits as they happen, and the verifier rejects any that slip through.
- If you edit the same files while a run is going, the change is not forced in; the worktree and patch are kept and the report says where.

## Limitations

- Claude Code only for now.
- Orchestration costs about one session per run regardless of task size. See [Is it worth it for you?](#is-it-worth-it-for-you).
- Token counts in the report cover the router, workers and verifier, not the orchestrating session.
- The benchmark is seven small tasks with one run each.

## Development

```sh
node --test "tests/unit/*.test.mjs"          # 45 unit tests, no dependencies
node tests/e2e/run.mjs --dry                 # plant every scenario, run pytest, no model calls
node tests/e2e/run.mjs [scenario ...]        # end-to-end via claude -p (about $0.2 per scenario)
node tests/e2e/bench.mjs                     # 7 tasks x 3 strategies (about $4.5)
```

The end-to-end scripts need `claude` and `uv` on `PATH`. Design, decisions and test results: [DESIGN.md](DESIGN.md).

## Credits

The brief format and the "verifier on a fresh context" rule are adapted from [pstack](https://github.com/michael-denyer/pstack-claude) (MIT).

## License

MIT
