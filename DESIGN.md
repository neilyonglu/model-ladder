# model-ladder — Design

[繁體中文](DESIGN.zh-TW.md)

Maintainer notes. User docs are in [README.md](README.md). A router picks the start and diagnoses failures; code enforces escalation. It supports Claude Code and Codex.

## Goals

Cheaper per verified task than a strong model at high effort; never report done without verification; never touch uncommitted work; two-command install, no proxy or API key. Non-goals: Gemini, best-of-N, dollar cost.

## Layout

```text
.claude-plugin/ .codex-plugin/ .agents/plugins/   manifests (same name and version), marketplace
skills/run/SKILL.md            Claude entry: preflight, workflow, finish
skills/handoff/SKILL.md        /model-ladder:handoff: main session writes HANDOFF.md
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

Layers: defaults → user file → project file. The user file is `~/.claude/model-ladder.json` or `~/.codex/model-ladder.json` (`CLAUDE_CONFIG_DIR` / `CODEX_HOME` replace the home folder; `MODEL_LADDER_USER_CONFIG` names the file outright, which every unit test sets through `tests/helpers/isolate-home.mjs`). Personal habits (`usageGuard`) belong there, so a committed project file never carries one person's switch; a project that sets `usageGuard` still overrides, for compatibility. One pure merge, `hooks/config-layers.mjs` (`mergeConfig`, `userConfigPath`, `pluginLayer`, `setGuard`), is shared by preflight, `usage-guard.mjs`, the band (through `$.fs` / `$.env`), the Codex runner and `watch.mjs`; `scripts/config.mjs` is its Node file reader and writer.

Skill instructions in Claude Code: the plugin's `worker_skills` / `verifier_skills` userConfig options are the default for every project. `skills/run/SKILL.md` pipes `${user_config.worker_skills}` / `${user_config.verifier_skills}` to `preflight.mjs --plugin-options` as JSON; `pluginLayer` drops values still holding `${` (not filled in) and puts the rest in the user layer, so a project key of the same name, even empty, wins. Preflight emits the merged values as `workflowArgs.skills`. The band merges the same way from its `options`. Codex has no settings UI and reads the keys from its own files.

Usage guard ownership: `usageGuard.enabled` changes only on a person's explicit action (band switch, `watch.mjs` `g` / `--guard`, editing a file). The band threshold field and `t` / `--threshold` write `setGuard(user, { threshold })`, one field, so an off guard stays off. Defaults such as the band's `enabled ?? true` are for display and are never written back. finish, preflight and the setup patch never write either settings file. All guard writes go to the user file; when the project file pins the field, the band toasts and `watch.mjs` says so instead of rewriting the project file. The Codex checkpoint comparison ignores `usageGuard`, so toggling it never blocks a resume.

## Grid and legal moves

| Move | Rule |
|---|---|
| Same tier, higher effort | Up to `maxEffortJump` steps |
| Next tier | Only `tier + 1`, any effort (may be lower: sonnet/high -> opus/low) |
| Down, sideways, skipping a tier | Never |

`legalMoves(cell, tiers)` is pure. The workflow hands the router the legal list (multiple choice, not rules from memory). Illegal or malformed answer -> default move: next effort in the tier, else lowest effort of the next tier.

## Flow (Claude Code)

```text
1. node scripts/preflight.mjs     -> READY + runId + workflowArgs, or a status needing the user
2. Workflow model-ladder:ladder   -> ROUTED | NEEDS_INPUT | DIRECT (first call, routes only)
   node scripts/claim.mjs         -> READY, or NEEDS_INPUT (overlap) / STALE_RUN
   Workflow model-ladder:ladder   -> VERIFIED | FAILED | STOPPED | USAGE_LIMIT (called again with plan)
3. node scripts/finish.mjs        -> apply, cleanup, history, report
```

Deterministic work lives in scripts (about five model calls per main session); workflows cannot touch the filesystem.

### Preflight
| Status | Meaning | Flag on yes |
|---|---|---|
| `ERROR` | Not a git repo with a commit, or invalid config | — |
| `STALE_RUN` | A run lock looks stale: dead pid, unreadable, or a legacy `run.json` (active or crashed) | `--clear-stale` |
| `OVERRIDDEN` | `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set | `--ignore-env` |
| `DIRTY` | Uncommitted changes | `--allow-dirty` |
| `USAGE_LIMIT` | Recorded usage >= threshold; no lock written | wait for reset |
| `READY` | `runId`; `workflowArgs`: `runId`, config, protection, `hasVerifySkill`, setup patch/files | — |

Dirty runs snapshot through a temporary index (`GIT_INDEX_FILE`), leaving the real index untouched: `baseTree` (HEAD + changes, untracked included), `setup.patch` (`git diff --cached --binary HEAD`, applied first by the worker), `setupFiles` (exempt from the protected check). Clean tree: `baseTree` = `HEAD^{tree}`. Run files live in `<repo>/.model-ladder/`: the lock `runs/<runId>.json`; the run's `state.json`, `setup.patch`, temporary index and a conflict's `result.patch` in `runs/<runId>/`; shared `history.jsonl`, `usage.json`, `HANDOFF.md`. Not under `.git` or `.claude`, where headless runs could not delete or edit them.

### Concurrent runs
Runs whose scopes do not overlap run side by side, across Claude Code and Codex (`scripts/runs.mjs`, shared by both runtimes and the guard).

- Lock: `.model-ladder/runs/<runId>.json` = `{ runId, runtime, pid, startedAt, protected, tests, scope, readOnly }`, written whole through a rename. `scope` is null until claimed. Codex records the runner's pid. Claude Code records `pid: null`: its scripts exit between steps and the session's pid is not reachable from them, so liveness is unknown and the lock counts as active until finish removes it.
- Claim: after routing, the run claims the router's `scope` (`claimScope`, under the `registry` mutex, so two claims never pass against each other). Claude Code: the workflow returns `ROUTED` when `args.runId` is set, the skill runs `scripts/claim.mjs`, then calls the workflow again with `plan`. Codex claims inside the runner. Unclaimed locks are skipped; they compare against this run when they claim. Read-only runs claim nothing and block nothing.
- Overlap, conservative: entries are normalized (`\` to `/`, `./` stripped, lowercased); a literal path covers itself and everything under it, a glob everything under the directory before its first wildcard; two entries overlap when one base contains the other. An empty scope, `**`, `*`, `.`, an absolute path or one with `..` becomes `**` (the whole repo). An overlap with an active run returns `NEEDS_INPUT` with `reason: "OVERLAP"` and `overlaps`; with a stale lock, `STALE_RUN`. The blocked run claims nothing and never touches the other lock.
- Stale: a lock is stale when its pid is dead, when it is unreadable, or when it is a legacy `.model-ladder/run.json` without a pid. Preflight and the Codex runner return `STALE_RUN` for any stale lock; `--clear-stale` / `clearStale: true` removes only stale locks. `--clear-stale=<runId>` / `clearStale: "<runId>"` also removes that lock (a crashed Claude Code session) unless its pid is alive.
- Legacy: an older version's `run.json` is one more run with scope `**`. With a live pid (older Codex runner) it blocks every claim; without one it is stale. Finish without `runId` closes a run an older preflight started (top-level `state.json`, `run.json`).
- Apply: results reach the checkout one run at a time under the `apply` mutex (Codex `applyResult`, Claude Code finish, including `commit`). A patch that no longer applies is still `CONFLICT` with the patch kept: the safety net when the router's scope was wrong. Preflight's dirty check and snapshot and the Codex runner's take the same mutex, so they never read half-applied files.
- Mutex: an exclusive file `runs/<name>.lock` with its owner's pid. A live owner is waited for (50 ms polls, 5 minute timeout; a Codex apply that times out is a `CONFLICT`); a dead owner's file is taken over through a rename that checks it moved the file it read.
- Dirty: another run's applied, uncommitted changes are uncommitted changes, so `DIRTY` still asks. Consent is safe: the run snapshots them and applies only its own files.
- Guard: merges `protected` (and, for `worker`, `tests`) of every readable lock, stale ones included; an unreadable lock adds nothing and switches nothing off.
- Pruning: `pruneRuns` skips any run dir an active lock names (its `runId` or `resumeRun`).
- Cleanup: finish removes the worktrees its attempts reported. Other new worktrees under `.claude/worktrees/` (a worker that died before reporting) are removed only when no other Claude Code lock exists and no earlier run kept them (`kept` in `history.jsonl`). Codex worktrees live in the temp dir and are never candidates.
- Not separated: `live.json` and the Codex panel show whichever run published last; `HANDOFF.md` is shared. Claude DIRECT edits after finish releases the lock. Codex DIRECT claims before creating the isolated draft, releases while the caller edits it, then reclaims scope before verification.

### Ladder or direct
Orchestration re-reads the caller's context, so in long sessions it can cost more than a cheap worker saves. The workflow returns `DIRECT` when the task is small (router's `small`: one or two files, design given) and the session holds at least `direct_threshold` percent of its context window (`contextTokens` / `contextWindow` from the skill; default 30, `off` never; plugin option, overridden per project). The threshold is code, not router judgment (sonnet/low misread "about 500000 tokens"). `--ladder` sets `forceLadder`. The skill does a direct case in the session, then dispatches `model-ladder:verifier` (config `verifier` model/effort, default the cheapest tier) on the diff, check-only, using the verify command or acceptance criteria. Failure reasons go back to the session to fix, then it re-verifies (at most three rounds). Codex supports an isolated DIRECT draft followed by independent runner verification when actual caller context data is supplied. A direct case still costs one router call; thresholds are a guess, not measured.

### Workflow
Route: the router returns start cell + reason, goal, scope, verify step, acceptance criteria, `allowTests` + reason, optional `question` (set when the task is too vague; else "make the shop better" passes on green tests). Verify source, first match wins: config `verify`; project verify skill `.claude/skills/verify/`; an existing test suite (the router may never write its own check, even a one-line assert); else `needsAcceptance` (user confirms criteria). Two vendored skills (from pstack, see NOTICE.md) help here: `/model-ladder:create-verification-skill` generates `.claude/skills/verify/`, `/model-ladder:maintain-verification-skill` keeps it honest. `NEEDS_INPUT` returns early; the skill asks and calls again. The router also returns `estimatedMinutes` (wall clock until verify passes, tests included) and `split` (`[{ task, scope }]`, empty at or under the limit). When the estimate exceeds `split_minutes` (default 20, `off` never), `split` is non-empty, and the run is not `forceLadder` or `DIRECT`, the workflow returns `NEEDS_INPUT` with `plan.splitSuggestion = { estimatedMinutes, limit, parts }` after any `question` and before acceptance. The skill offers split / whole / stop: split runs each part as its own full run in order, whole calls again with `acceptSplit: false`. The comparison is code; the estimate is the router's guess. Codex uses the same key and split comparison, returning NEEDS_INPUT with reason SPLIT.

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
- Hard limit: a thrown error whose message says Claude's subscription limit is spent (`hardLimit()` in the pure section: "hit your session limit", usage limit, rate limit, 429, too many requests) stops the run at once from any step (route, worker, verifier, diagnosis, final diagnosis) with `USAGE_LIMIT`; `final.reason` carries the role, the reset time when the message names one, and the raw message. No further agent is spawned, because it would die the same way. This is independent of `usageGuard`. A null return carries no message, so a silent death still counts as an ordinary failed step.
- Usage guard: preflight always passes `usageGuard.command` (`scripts/usage-guard.mjs --root <repo>`). The verifier runs it last and returns its output in `usage`: `{"enabled", "threshold", "usage"}` as the settings and usage are at that moment. `guardStop()` stops a failed attempt only when `enabled` is true and a known `usage` >= `threshold`; unreadable output or `enabled: false` never stops. So a person's switch or new threshold counts at the next check, mid-run included.
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
- Patch conflicts (user or another run edited the same files): keep the worktree and `runs/<runId>/result.patch`, report where.
- Remove the run's worktrees and `worktree-wf_*` branches (failed ones kept when `keepFailed`; see Concurrent runs for which worktrees count as the run's); delete the run's lock, state and setup patch (a crash never leaves the guard armed for it); append history with `runId` and `kept`; print the report.

`USAGE_LIMIT` (guard or hard limit) keeps the last reported attempt's worktree and, because a worker stopped by the limit never reports its path, also keeps this run's unreported worktrees under `.claude/worktrees/` instead of removing them as orphans; the handoff points at that one when the last attempt reported none. It also writes the template `HANDOFF.md` (task, attempts, status, worktree, resume command). That is the authoritative, program-generated record and the fallback. The template lacks what only the main session knows (the user's preferences, decisions, next steps), so `skills/run/SKILL.md` has the main session rewrite the file afterwards from its whole conversation, in the user's language: AI sections (`Goal`, `User preferences and decisions`, `Done and not done`, `Suggested next steps`, `How to resume`) followed by `Appendix: program-generated verification (authoritative)`, the template pasted unchanged. The two parts are labeled so a reader never mistakes AI claims for verification; where they differ the appendix wins. `/model-ladder:handoff` (`skills/handoff/SKILL.md`) does the same on demand: `finish.mjs --handoff` regenerates the template from the last `history.jsonl` entry, then the session rewrites it. The band's `handoff now` button writes its own template (it can include running rows) and then calls `$.prompt.submit({ text: '/model-ladder:handoff', asUser: true })`, which the mod API runs as a turn once the session is idle; if the submit fails, a toast names the command. Codex follows the same procedure from `codex-skills/model-ladder/SKILL.md` (template from the runner or `watch.mjs --handoff`); when Codex has hit its hard usage limit and cannot call the model, the template stays.

Availability check: after preflight and before the workflow (Claude) or the runner (Codex), the main session compares the skills, plugins and MCP servers named in `worker_skills` / `verifier_skills` with what it can use, and warns the user about unavailable ones without stopping the run. It is a best-effort model judgment, not a parser, and it never edits the settings. Capability blockers reported by roles are listed again in the final report.

## Brief
Fields: GOAL, TASK, SCOPE, ACCEPTANCE (user, else router), VERIFY (config / verify skill / router), FORBIDDEN (preflight + `allowTests`), SETUP (dirty only), PREVIOUS and HINT (attempt 2+), REPORT `worktreePath`. Test-writing tasks run on `test-writer`, others on `worker`; they differ only in test protection, so the hook can tell by `agent_type` and the lock is written once, before the router decides `allowTests`.

## Protected paths

```text
tests (worker only)  **/test_*.py **/*_test.py **/tests/** **/__tests__/** **/*.test.* **/*.spec.* **/src/test/**
always               .claude/model-ladder.json, plus config "protected"
```

The ladder config is always protected, or a worker could rewrite the verify command. Two layers:

1. **Hook** (`guard.mjs`, PreToolUse, early, best effort): blocks (exit 2) only when the caller is a ladder worker/test-writer, at least one run lock exists and the path matches the merged patterns of all locks. Fails open if Node is missing. Outside a run the user is never blocked.
2. **Verifier diff** (always): `git status --porcelain --untracked-files=all` in the worktree against the same globs, catching Bash edits. Ignores artifacts the verify step rewrites (`__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules`, `target`, `build`, `dist`, `coverage`).

Codex additionally protects npm scripts (incl. nested manifests), npm config, the selected verify skill dir, and selected build manifests; it compares actual Git trees before and after verification. New files under `dist`, `build`, `target` are excluded; files already in the baseline tree stay checked.

## Report and history
FAILED and STOPPED reports end with the router's explanation. Tokens are output tokens per agent call (`budget.spent()` delta); input tokens, the main session and dollars are unavailable. History: one JSON line per run in `.model-ladder/history.jsonl` (task, status, start, attempts with cell/result/reason/action/tokens, applied, committed). The scripts' report is input for the calling session, which sends one summary in the user's session language (status, changed files, verification, limits and follow-ups), keeping technical names as is.

## Releases
Claude Code offers an update only when `version` in `.claude-plugin/plugin.json` changes.

- `scripts/update-check.mjs` reads the published `plugin.json` at most daily (cached in the OS temp dir); finish appends an update line. Silent on failure; `MODEL_LADDER_NO_UPDATE_CHECK=1` disables; nothing is sent.
- CI (`.github/scripts/check-version.mjs`) fails if plugin dirs (`.claude-plugin`, `.codex-plugin`, `.agents/plugins`, `codex-skills`, `skills`, `agents`, `hooks`, `scripts`, `workflows`) changed since the latest `v*` tag without a version bump. Docs-only changes need none.
- Each release: sync both manifest versions, bump, `CHANGELOG.md` entry, `vX.Y.Z` tag and GitHub Release.

## Codex runtime

- The standalone runner `scripts/codex-run.mjs` owns route, attempts, verification, diagnosis and incremental patching. It calls native `codex exec` with argument arrays, stdin, explicit model/effort, strict JSON schemas, ephemeral sessions and read-only or workspace-write sandboxes; it never disables approvals or sandbox.
- Each run has a UUID dir, temporary Git indexes and an explicit list of created worktrees (cleanup never infers ownership by diffing worktree lists). Each run writes its own lock `.model-ladder/runs/<runId>.json` first and claims the router's scope before any worker (see Concurrent runs). Dirty changes need consent; read-only work is isolated too.
- Run artifacts: the `codex-<uuid>/` dir (attempt worktrees, events/stderr logs, schemas/outputs, snapshot indexes, checkpoint, `result.json`, a conflict's `result.patch`) lives at `artifactDir(root)` = `os.tmpdir()/model-ladder/<first 16 hex of sha256 of the canonical repo path>/` (`scripts/common.mjs`; lowercased on case-insensitive platforms, canonical so git and the runner spell worktree paths the same). `.model-ladder/` keeps only `runs/`, `history.jsonl`, `HANDOFF.md`, `live.json`, `usage.json`. Result paths, `resumeRun` and checkpoints all use the temp dir. After taking the lock, `pruneRuns` deletes finished run dirs there (and unregisters their worktrees), keeping `CONFLICT`, patch, checkpoint, unfinished (no `result.json`) runs, runs an active lock names and, with `keepFailed`, runs that still have attempts. Run dirs left in `.model-ladder/` by older versions are not pruned. The Claude Code runner's transient `state.json`, `setup.patch` and temporary index stay in `.model-ladder/runs/<runId>/` and are deleted by finish.
- Test commands come from trusted config or deterministic discovery (verify skills win). After command checks pass, a separate Codex invocation judges semantic acceptance. Editing-task verifiers use workspace-write (build artifacts allowed, inputs re-checked); report-only verifiers are read-only. No check and no acceptance -> `NEEDS_INPUT`. Model output is schema-validated. Model/auth/sandbox failures stop rather than escalate. Codex's own usage, rate or quota errors (`usageLimitFailure` in `codex-exec.mjs`) stop with `errorCode: USAGE_LIMIT`, so the runner writes `HANDOFF.md` as for the guard; when the text also matches an auth/sandbox/model pattern, it stays a plain environment error.
- Entry points: task argument, JSON on stdin, or `--input <file>` (UTF-8, BOM ok). Exit codes in README. `DIRECT` requires both caller-supplied context numbers and a small-task routing decision. It retains an isolated draft and checkpoint; `directRun` plus `directSummary` sends that draft through the normal independent verification and apply path without a worker call. No context estimate is fabricated. `commit: true` is opt-in and commits only verified files whose original and current contents are safe to commit, under the apply mutex; otherwise the change remains applied with a note.
- Interruption: `timeoutMs` is idle time without output. SIGINT/SIGTERM/timeout stop children and release the run's lock; interrupted workers/verifiers keep draft worktree, checkpoint and `resumeRun`. Resume checks commit, dirty snapshot, task, acceptance and config, seeds a fresh worktree from the draft and re-verifies. The skill resumes a timeout at most twice.
- Guard: reads the newest local session's unexpired rate-limit windows before each role and verify command, reloading the layered settings (user file, then project) at those boundaries; at the threshold returns `STOPPED` with `errorCode: USAGE_LIMIT`, `handoffPath`, checkpoint if any. Highest percentage across all unexpired windows counts.
- Live state: `scripts/codex-live.mjs` atomically replaces `.model-ladder/live.json` = `{ runId, updatedAt, agents: [{ phase, model, effort, task, startedAt, endedAt, pass }], usage: { fiveHour, sevenDay } }` (ISO strings; active rows have null `endedAt`/`pass`). Latest run only; SIGKILL can leave stale active rows. `watch.mjs` refreshes each second, drops completed rows after 10 s, truncates to cell width (CJK/emoji aware), sanitizes control chars, appends frames when redirected. Only windows of 300/10080 minutes are labelled 5h/7d, else `?`. `--guard`/`--threshold` update the user file `~/.codex/model-ladder.json` atomically, preserving other fields, and never the project file.

## Session guidance and band

- Both runtimes ship a default-on SessionStart hook (`hooks/autorun.mjs`) telling the agent to route every top-level task (any kind) through the ladder unless the user opts out; the router decides DIRECT or agents, outside Git the agent says a repo is needed and works directly, and roles never start another ladder. Instruction-based, subject to user/project instructions. `MODEL_LADDER_AUTORUN=0` or the `autoRun` option disables it; Codex hooks must be trusted.
- The band is registered separately (`hooks/band.json`, so older Claude Code still runs the ladder): tracks agent events, 1 s refresh, finished rows kept 10 s, one notice at 10 minutes (no turn caps). Its measurement handler writes `.model-ladder/usage.json`; `usage-statusline.mjs` is the fallback. Claude guard settings are read live at preflight and by the verifier after each attempt (`usage-guard.mjs`). Band controls edit the user file `~/.claude/model-ladder.json` only, one field per action.
Settings `worker_skills` / `verifier_skills` add a SKILL INSTRUCTIONS section to worker (including test-writer) and verifier prompts. In Claude Code they are plugin options (the default for every project) that a project overrides with the same key in `.claude/model-ladder.json`; preflight merges them (strings, else `ERROR`) and passes them as `workflowArgs.skills` (see Config). Codex uses the same keys in `.codex/model-ladder.json` or `~/.codex/model-ladder.json`. The band shows the merged values and nothing when they are empty or unreadable. Nonempty strings pass through intact without comma parsing; values still containing `${` are dropped. For example, "When coding, use ponytail to review and simplify the code; when working on UI, use available UI/UX skills." The existing role models interpret conditions and existing skill-name values, select and use relevant available skills, plugins, slash commands and MCP tools within their role scope (a name may be a skill, plugin or MCP server name), and report missing applicable required capabilities as blockers listing the capabilities checked. The worker, test-writer and verifier agents declare no `tools` allowlist, so they inherit every session tool including MCP tools; `disallowedTools: Workflow, Agent` blocks recursion and spawning, and the verifier body forbids file modification. Skill instructions cannot override permissions, protected paths or verification rules, let a verifier fix code, or invoke model-ladder recursively. No extra routing call, parser, dependency or config migration is involved. Both displays label the configured text `skill instructions:` rather than claiming it was used. The band's handoff button writes `.model-ladder/HANDOFF.md`.

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

- Run files under `.git` can't be deleted, under `.claude` neither (headless) -> `.model-ladder/`. Per-run Codex artifacts (worktrees, logs) then moved to the system temp dir so they stop occupying the repo.
- pytest rewrote a tracked `.pyc` and failed a correct fix -> artifact globs ignored by the verifier.
- `git add -A -- . ':!.model-ladder'` fails when the path is gitignored -> add all to the temp index, then `git rm --cached` own folders.
- haiku failed structured output five times and `agent()` threw -> a throwing agent is a failed step.
- With no tests, the router wrote its own assert as verify -> only pre-existing checks allowed.
- A vague task passed on green tests -> router may ask one question first.
- Windows: spawning `claude` through a shell split the task on spaces ("asks" scenarios passed vacuously) -> spawn directly; check the question text.

### Codex panel parity (1.8)

Codex's SessionStart hook supplies explicit setup instructions for a persistent PTY watcher and desktop terminal visibility. The skill repeats setup as a fallback when invoked explicitly. The watcher is a terminal panel, not a Claude Code UI module; it cannot render above the Codex composer. Hook trust is managed by Codex and must not be bypassed. `autoRun` and `band` are independent layered settings (personal, then project). Internal role processes inherit `MODEL_LADDER_ROLE` and turn off panel/autorun setup to prevent recursion.

The live state stores task, input, role skills, retry state and the final result. The watcher renders the same phase lights and rounded reset countdowns as Claude, and accepts guard/threshold/handoff commands followed by Enter. Handoff never interrupts an active run. Both runtimes ship verification-skill generators and maintainers; Codex generates `.agents/skills/verify/` and can consume an existing Claude verification skill.

## Runtime parity audit (1.1.0)

| Capability | Claude Code | Codex |
|---|---|---|
| DIRECT | Router small decision and host context ratio; session works, separate verifier checks | Actual caller context numbers only; isolated caller draft, then directRun verifies and applies. No automatic context API is assumed |
| Commit | Opt-in commit in finish | Opt-in commit inside apply mutex; skip if affected files contain earlier or concurrent edits; default false |
| Split | Router estimate, user chooses parts, whole or stop | Same split_minutes rule; acceptSplit false chooses whole; forceLadder disables both split and DIRECT |
| Tests | test-writer only when task requests tests; explicit protected paths stay forbidden | Same permission gate and test-writing rules in worker prompt; no separate host agent type required |
| Verification | Command or approved criteria, independent verifier | Configured command, project verify skill or deterministic discovery plus independent semantic verifier; no fabricated acceptance |
| Escalation | Shared legalMoves/pickMove rules, clean retries | Same generated rules; fresh worktrees; auth/model/sandbox failures stop rather than upgrade |
| Autorun | SessionStart instruction and plugin options | Trusted SessionStart instruction, personal/project config and environment switches; roles disable recursion |
| Usage guard | Latest guard at preflight/verification, hard-limit detection | Role boundaries plus polling during children; native quota errors also stop registered runners |
| Resume | Kept worktree and handoff; restart through skill | Validated checkpoint for interrupted draft, fresh worktree and independent re-verification; timeout auto-resume capped at two |
| Skill instructions | Natural-language text to worker/test-writer/verifier; capability blockers reported | Same strings and role boundaries; only capabilities actually available in each child may be used |
| Concurrent runs | Shared scope registry and apply mutex | Same helpers; DIRECT releases its active lock while caller edits an isolated draft and reclaims scope on return |
| Handoff | Main conversation plus unchanged generated appendix | Same separation; per-run live snapshots prevent automatic quota handoffs using another run's state; shared HANDOFF.md remains last writer wins |

Platform limits: a child process cannot inherit the parent's private conversation or tools that the installed child host does not expose. Autorun is an instruction, not an interception API. Registered runner process trees can be stopped; no API is assumed to cancel arbitrary Claude host sessions or their hosted agents. Claude's native band, plugin settings UI and measured context differ from Codex's terminal panel, JSON config and unavailable automatic context metrics. For Codex, configure targeted verify explicitly or use a project verify skill when deterministic test discovery would run too much. Offline fakes prove control flow, not authentication, model quality, installed host dispatch or live UI.

On Windows, a sandbox may deny taskkill /T /F even for a fixture child. The guard reports the error, keeps the active registration and does not write a false stopped handoff. This boundary requires verification where the existing sandbox permits process-tree termination; it is never replaced with a weaker single-PID kill or a bypass flag.
