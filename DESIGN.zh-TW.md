# model-ladder 設計

[English](DESIGN.md)

維護者說明。使用者文件見 [README.zh-TW.md](README.zh-TW.md)。router model 選擇起點並診斷失敗，程式碼強制升級規則。支援 Claude Code 與 Codex。

## 目標與版面配置

目標是以比高 effort 強模型更低的每件已驗證任務成本完成工作，不經驗證不回報完成，不碰未提交工作，以兩個命令安裝且不需 proxy 或 API key。非目標是 Gemini、best-of-N、dollar cost。

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

`workflows/ladder.js` 的 pure block 是 canonical。`scripts/sync-rules.mjs` 產生供 Node import 的 `scripts/ladder-rules.mjs`，unit test 拒絕 drift。

## 角色、設定與合法移動

| 角色 | 模型／effort | 工具 | 工作 |
|---|---|---|---|
| 技能（主 session） | sonnet / medium | 全部 | 執行兩個 script 與 workflow，並詢問使用者 |
| Router | `router` (sonnet/low) | Read、Grep、Glob | 選擇起始 cell、診斷失敗、撰寫最終說明 |
| Worker／test-writer | 目前 cell | Read、Grep、Glob、Edit、Write、Bash | 在新的 worktree 依 brief 實作 |
| Verifier | 有 verify 命令時使用 `verifier` (haiku/low)，否則使用 router | Read、Grep、Glob、Bash | 檢查保護規則、執行 verify，或判斷是否符合 acceptance |

命令由 cheap verifier 執行，criteria 由 router model 判斷。Skill 固定 sonnet/medium，因為它執行 `git apply` 與移除 worktree。Key、default 與意義見 [README Configure](README.md#configure)。`scripts/preflight.mjs` 的 `DEFAULTS` 是 source of truth。top-level key 取代 default，僅 `usageGuard` 逐欄位 merge。`preflight.mjs` 驗證並列出每個問題。Codex 使用自己的 `.codex/model-ladder.json` defaults（`scripts/codex-run.mjs`）。

設定分層：預設值 → 使用者檔 → 專案檔。使用者檔為 `~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`（`CLAUDE_CONFIG_DIR`／`CODEX_HOME` 取代家目錄；`MODEL_LADDER_USER_CONFIG` 直接指定檔案，所有 unit test 都透過 `tests/helpers/isolate-home.mjs` 設定它）。個人習慣（`usageGuard`）放這裡，會 commit 的專案檔不會帶著某個人的開關；專案若寫了 `usageGuard` 仍會覆蓋，保持相容。preflight、`usage-guard.mjs`、band（透過 `$.fs`／`$.env`）、Codex runner 與 `watch.mjs` 共用同一個純函式模組 `hooks/config-layers.mjs`（`mergeConfig`、`userConfigPath`、`pluginLayer`、`setGuard`）；`scripts/config.mjs` 是它的 Node 讀寫端。

Claude Code 的 skill 指示：plugin userConfig 的 `worker_skills`／`verifier_skills` 是所有專案的預設。`skills/run/SKILL.md` 把 `${user_config.worker_skills}`／`${user_config.verifier_skills}` 以 JSON 交給 `preflight.mjs --plugin-options`；`pluginLayer` 丟棄仍含 `${` 的值（未填入），其餘放進使用者層，所以專案檔有同名鍵（即使是空字串）就以專案為準。preflight 輸出合併後的 `workflowArgs.skills`，band 以自己的 `options` 用同樣方式合併。Codex 沒有設定介面，從自己的設定檔讀取。

Usage guard 的開關只屬於使用者：`usageGuard.enabled` 只會因使用者的明確操作改變（band 開關、`watch.mjs` 的 `g`／`--guard`、手動編輯設定檔）。band 門檻欄位與 `t`／`--threshold` 寫入 `setGuard(user, { threshold })`，只改一個欄位，關閉的 guard 維持關閉。band 的 `enabled ?? true` 等預設只用於顯示，從不寫回。finish、preflight 與 setup patch 都不寫任何設定檔。guard 的寫入一律寫使用者檔；專案檔固定該欄位時，band 以 toast、`watch.mjs` 以訊息說明，不改寫專案檔。Codex checkpoint 比對會忽略 `usageGuard`，切換開關不會擋住 resume。

| 移動方式 | 規則 |
|---|---|
| 同 tier 提高 effort | 最多移動 `maxEffortJump` 個 effort 階級 |
| 升到下一 tier | 只能升到 `tier + 1`，effort 可任選（也可較低，例如 sonnet/high -> opus/low） |
| 降級、橫向移動或跳過 tier | 不允許 |

`legalMoves(cell, tiers)` 是 pure。workflow 將 legal list 交給 router。非法或 malformed answer 的 default move 是同 tier 下一個 effort，否則下一 tier 最低 effort。

## 流程

```text
1. node scripts/preflight.mjs     -> READY + runId + workflowArgs, or a status needing the user
2. Workflow model-ladder:ladder   -> ROUTED | NEEDS_INPUT | DIRECT (first call, routes only)
   node scripts/claim.mjs         -> READY, or NEEDS_INPUT (overlap) / STALE_RUN
   Workflow model-ladder:ladder   -> VERIFIED | FAILED | STOPPED | USAGE_LIMIT (called again with plan)
3. node scripts/finish.mjs        -> apply, cleanup, history, report
```

確定性工作在 scripts 中，約每個 main session 五次 model calls。workflow 不能碰 filesystem。`ERROR` 代表非有 commit 的 git repo 或 invalid config；`STALE_RUN`（鎖的 pid 已不存在、鎖無法讀取，或舊版 `run.json`）用 `--clear-stale`；`OVERRIDDEN`（`CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`）用 `--ignore-env`；`DIRTY` 用 `--allow-dirty`；`USAGE_LIMIT`（recorded usage >= threshold）等待 reset，不寫鎖；`READY` 帶有 `runId`，以及含 `runId`、config、protection、`hasVerifySkill`、setup patch/files 的 `workflowArgs`。

Dirty run 以 `GIT_INDEX_FILE` snapshot，不碰 real index。`baseTree` 是 HEAD 加變更（含 untracked），`setup.patch` 是 `git diff --cached --binary HEAD`，worker 先套用，`setupFiles` 免 protected check。clean tree 的 `baseTree` 是 `HEAD^{tree}`。run files 位於 `<repo>/.model-ladder/`：鎖 `runs/<runId>.json`；該 run 的 `state.json`、`setup.patch`、temporary index 與衝突時的 `result.patch` 在 `runs/<runId>/`；共用的 `history.jsonl`、`usage.json`、`HANDOFF.md`。不放在 `.git` 或 `.claude`，因 headless run 無法刪除或編輯後兩者。

### 同時執行
scope 不重疊的 run 可並行，Claude Code 與 Codex 之間也會互相協調（`scripts/runs.mjs`，兩個 runtime 與 guard 共用）。

- 鎖：`.model-ladder/runs/<runId>.json` = `{ runId, runtime, pid, startedAt, protected, tests, scope, readOnly }`，以 rename 整檔寫入。認領前 `scope` 為 null。Codex 記錄 runner 的 pid。Claude Code 記錄 `pid: null`：它的 scripts 在步驟之間就結束，也拿不到 session 的 pid，因此存活狀態未知，鎖在 finish 移除前都視為作用中。
- 認領：route 後，run 認領 router 的 `scope`（`claimScope`，在 `registry` mutex 內，兩個認領不會互相放行）。Claude Code：`args.runId` 有值時 workflow 回傳 `ROUTED`，skill 執行 `scripts/claim.mjs`，再帶 `plan` 呼叫 workflow。Codex 在 runner 內認領。尚未認領的鎖會略過，輪到它們認領時再與本 run 比對。Read-only run 不認領、也不擋人。
- 重疊判斷（保守）：條目先正規化（`\` 轉 `/`、去掉 `./`、轉小寫）；字面路徑涵蓋自己與其下所有檔案，glob 涵蓋第一個萬用字元前的目錄；兩條目的 base 有包含關係即重疊。空 scope、`**`、`*`、`.`、絕對路徑或含 `..` 的路徑都變成 `**`（整個 repo）。與作用中 run 重疊回傳 `NEEDS_INPUT`，附 `reason: "OVERLAP"` 與 `overlaps`；與過期的鎖重疊回傳 `STALE_RUN`。被擋下的 run 不認領任何東西，也不碰另一個鎖。
- 過期：pid 已不存在、無法讀取，或沒有 pid 的舊版 `.model-ladder/run.json`。Preflight 與 Codex runner 遇到任何過期鎖都回傳 `STALE_RUN`；`--clear-stale` / `clearStale: true` 只移除過期鎖。`--clear-stale=<runId>` / `clearStale: "<runId>"` 另外移除該鎖（當掉的 Claude Code session），除非其 pid 仍存活。
- 相容：舊版的 `run.json` 視為 scope 為 `**` 的另一個 run。pid 存活（舊版 Codex runner）時擋下所有認領；沒有 pid 時視為過期。沒有 `runId` 的 finish 會收尾舊版 preflight 開始的 run（最上層的 `state.json`、`run.json`）。
- 套用：結果在 `apply` mutex 內一次一個 run 寫入工作目錄（Codex `applyResult`、Claude Code finish，含 `commit`）。patch 套不上仍是 `CONFLICT` 並保留 patch，作為 router scope 預估錯誤時的安全網。Preflight 與 Codex runner 的 dirty 檢查與 snapshot 也取同一個 mutex，不會讀到套用到一半的檔案。
- Mutex：獨佔檔 `runs/<name>.lock`，內含持有者 pid。持有者存活就等待（每 50 ms 檢查、5 分鐘逾時；Codex 套用逾時視為 `CONFLICT`）；持有者已死則以 rename 接手，並確認搬走的是剛讀到的那個檔。
- Dirty：另一個 run 已套用但未 commit 的變更就是未提交變更，`DIRTY` 照樣詢問。同意是安全的：run 會 snapshot 這些變更，且只套用自己的檔案。
- Guard：合併所有可讀鎖的 `protected`（`worker` 另加 `tests`），過期鎖也算；無法讀取的鎖不增加規則，也不關閉其他規則。
- 清理：`pruneRuns` 略過任何作用中鎖提到的 run dir（其 `runId` 或 `resumeRun`）。Finish 移除自己 attempts 回報的 worktree；`.claude/worktrees/` 下其他新出現的 worktree（worker 回報前就死掉）只在沒有其他 Claude Code 鎖、且沒有先前 run 保留它（`history.jsonl` 的 `kept`）時才移除。Codex worktree 在 temp dir，不在候選內。
- 未分開的部分：`live.json` 與 Codex panel 顯示最後發布的 run；`HANDOFF.md` 共用。`DIRECT` 不認領 scope：session 是在 finish 釋放鎖之後才修改。

長 session 重讀 caller context 可能比 cheap worker 節省的成本高。任務小（router `small`：一或兩檔，design given）且 session context 達 window 的 `direct_threshold` 百分比（skill 傳 `contextTokens` / `contextWindow`；預設 30，`off` 為永不；plugin 選項，專案可覆蓋）時回傳 `DIRECT`。threshold 是 code，不由 router 判斷，因 sonnet/low 曾誤讀 about 500000 tokens。`--ladder` 設 `forceLadder`。skill 在 session 內完成 direct 任務後，會對 diff 派出 `model-ladder:verifier`（設定中 `verifier` 的 model/effort，預設最便宜層級），只檢查不修改，依 verify 指令或驗收條件判斷。失敗原因交回 session 修正後再驗（最多三輪）。Codex 沒有 `DIRECT` 路徑。DIRECT 仍需一次 router call，threshold 未量測。

Router 回傳 start cell + reason、goal、scope、verify step、acceptance criteria、`allowTests` + reason 與可選 `question`。任務太模糊時才有 `question`，避免 "make the shop better" 因 green tests 通過。verify source 依序為 config `verify`、`.claude/skills/verify/`、existing test suite（router 不能自行寫 check，包括 one-line assert）、或 `needsAcceptance`。來自 pstack 的 `/model-ladder:create-verification-skill` 產生 `.claude/skills/verify/`，`/model-ladder:maintain-verification-skill` 維護它。`NEEDS_INPUT` 提早回傳，skill 詢問後再呼叫。Router 另回傳 `estimatedMinutes`（到 verify 通過的牆鐘時間，含測試）與 `split`（`[{ task, scope }]`，不超過門檻時為空）。預估超過 `split_minutes`（預設 20，`off` 為永不）、`split` 非空，且不是 `forceLadder` 或 `DIRECT` 時，workflow 回傳 `NEEDS_INPUT`，帶 `plan.splitSuggestion = { estimatedMinutes, limit, parts }`；順序在 `question` 之後、acceptance 之前。skill 詢問分段／整個照跑／停止：分段時每個子任務各自完整跑一次，整個照跑則帶 `acceptSplit: false` 再呼叫。比較由 code 判斷，預估是 router 的猜測。Codex 不讀此鍵。

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

每次 attempt 從 base 的 clean worktree 開始，只帶 failure summaries 與 hints。`agent()` death 的 null 與 invalid structured output 的 throw 都是 failed step。只有 failed route 會 stop。例外是硬上限：throw 的錯誤訊息若表示 Claude 訂閱額度已用完（pure section 的 `hardLimit()`：「hit your session limit」、usage limit、rate limit、429、too many requests），不論在 route、worker、verifier、diagnosis 或 final diagnosis，都立即以 `USAGE_LIMIT` 停止、不再派下一個 agent；`final.reason` 帶角色、訊息中的重置時間與原始訊息。這與 `usageGuard` 無關。null 沒有訊息，無聲死亡仍算一般 failed step。Usage guard：preflight 一律傳 `usageGuard.command`（`scripts/usage-guard.mjs --root <repo>`），verifier 最後執行並把輸出放進 `usage`：當下的 `{"enabled", "threshold", "usage"}`。`guardStop()` 只在 `enabled` 為 true 且已知 `usage` >= `threshold` 時停止失敗的 attempt；讀不懂的輸出或 `enabled: false` 永不停止，所以使用者在 run 中途切換開關或改門檻，下一次檢查就生效。router 看最新 attempt 完整內容（最後 200 行 verify output）與較早 summary。worst case 為 14 agent calls。`raise_effort` 是同 tier 較高 effort，`raise_model` 是 next tier，`stop_environment` 是 missing dependency/broken setup/unreachable service，`stop_unclear` 是 ambiguous task。worker 的 `status: "blocked"` 是 failure，進 diagnosis。

## Finish、brief 與保護

Finish 從 stdin 讀 workflow result 或 abort reason/error。`VERIFIED` 時 stage winning worktree、`git write-tree`、以 `git diff --binary baseTree resultTree` 套用 working tree，與 `baseTree` diff 可排除使用者變更。`commit` true 時只以 `model-ladder: <goal>` 提交 patch files。patch conflict（使用者或另一個 run 改了同樣的檔案）時保留 worktree 與 `runs/<runId>/result.patch` 並回報。移除本 run worktrees 和 `worktree-wf_*` branches（哪些算本 run 見「同時執行」），`keepFailed` 時保留 failed ones，然後刪本 run 的鎖/state/setup patch、append 含 `runId` 與 `kept` 的 history、print report。

`USAGE_LIMIT`（guard 或硬上限）保留最後一次有回報的 attempt worktree；因為被上限打斷的 worker 不會回報路徑，也保留本 run 在 `.claude/worktrees/` 下未回報的 worktree，不當成孤兒刪除，最後一次 attempt 沒回報路徑時交接檔指向它。`USAGE_LIMIT` 也會寫模板版 `HANDOFF.md`（task、attempts、狀態、worktree、續跑命令），這是程式產生的權威紀錄，也是備案。模板缺少只有主 session 知道的內容（使用者偏好、決定、下一步），所以 `skills/run/SKILL.md` 要求主 session 之後根據完整對話、用使用者的語言改寫：先是 AI 撰寫的區段（`Goal`、`User preferences and decisions`、`Done and not done`、`Suggested next steps`、`How to resume`），再接 `Appendix: program-generated verification (authoritative)`，內容為原封不動貼上的模板。兩部分明確標示，讀者不會把 AI 的說法當成驗證結果；兩者不一致時以附錄為準。`/model-ladder:handoff`（`skills/handoff/SKILL.md`）可隨時手動做同樣的事：`finish.mjs --handoff` 先從 `history.jsonl` 最後一筆重產模板，再由 session 改寫。band 的 `handoff now` 按鈕先寫自己的模板（可包含執行中的列），再呼叫 `$.prompt.submit({ text: '/model-ladder:handoff', asUser: true })`，mod API 會在 session 閒置後以一個 turn 執行；提交失敗時 toast 會提示該命令。Codex 依 `codex-skills/model-ladder/SKILL.md` 走同樣流程（模板來自 runner 或 `watch.mjs --handoff`）；Codex 已撞到硬上限、無法再呼叫模型時，保留模板版。

可用性檢查：preflight 之後、workflow（Claude）或 runner（Codex）之前，主 session 會把 `worker_skills`／`verifier_skills` 提到的 skill、plugin、MCP server 與自己可用的能力比對，對不可用者提醒使用者，但不中止 run。這是盡力而為的模型判斷，不是 parser，也不會修改設定。各角色回報的能力 blocker 會在最終報告中再列出。

Brief 有 GOAL、TASK、SCOPE、ACCEPTANCE、VERIFY、FORBIDDEN、SETUP、PREVIOUS、HINT、REPORT `worktreePath`。test task 用 `test-writer`，其餘用 `worker`，只在 test protection 不同。hook 依 `agent_type` 區分，鎖在 router 決定 `allowTests` 前寫一次。

```text
tests (worker only)  **/test_*.py **/*_test.py **/tests/** **/__tests__/** **/*.test.* **/*.spec.* **/src/test/**
always               .claude/model-ladder.json, plus config "protected"
```

ladder config 永遠受保護。Hook（`guard.mjs`、PreToolUse、early、best effort）僅在 ladder worker/test-writer、至少有一個 run 鎖、path 符合所有鎖合併後的 pattern 時 exit 2 阻擋。Node 缺失則 fails open，run 外不阻擋使用者。Verifier diff 永遠用同 globs 查 worktree 的 `git status --porcelain --untracked-files=all`，也可捕捉 Bash edits；忽略 `__pycache__`、`*.pyc`、`.pytest_cache`、`node_modules`、`target`、`build`、`dist`、`coverage`。Codex 另保護 npm scripts（含 nested manifests）、npm config、selected verify skill dir、selected build manifests，比較 verify 前後 Git trees。新 `dist`、`build`、`target` files 不列入，baseline tree 已有檔仍檢查。

## Report、release、Codex

FAILED/STOPPED report 以 router explanation 結尾。tokens 是每 agent call 的 output tokens（`budget.spent()` delta）；input tokens、main session、dollars 不可得。`.model-ladder/history.jsonl` 每 run 一行，含 task、status、start、attempt cell/result/reason/action/tokens、applied、committed。scripts 的 report 是給呼叫端 session 的輸入，由它以使用者在 session 使用的語言統整成一份摘要（狀態、變更檔案、驗證、限制與待辦），技術名詞保留原文。Claude Code 僅在 `.claude-plugin/plugin.json` 的 `version` 改變時提示更新。`scripts/update-check.mjs` 每日最多讀一次 published `plugin.json`，快取於 OS temp dir，finish append update line；失敗靜默，`MODEL_LADDER_NO_UPDATE_CHECK=1` 關閉，沒有資料送出。CI 的 `.github/scripts/check-version.mjs` 在 plugin dirs 自最新 `v*` tag 後改動未 bump version 時失敗，docs-only 不需 bump。release 要同步 manifests version、bump、`CHANGELOG.md` entry、`vX.Y.Z` tag、GitHub Release。

`scripts/codex-run.mjs` 處理 route、attempts、verification、diagnosis、incremental patching。它以 argument arrays、stdin、explicit model/effort、strict JSON schemas、ephemeral sessions、read-only 或 workspace-write sandbox 呼叫 native `codex exec`，從不關閉 approvals/sandbox。每 run 用 UUID dir、temporary Git indexes、explicit created-worktrees list。每個 run 先寫自己的鎖 `.model-ladder/runs/<runId>.json`，並在任何 worker 前認領 router 的 scope（見「同時執行」）。dirty changes 需要 consent，read-only 也隔離。run 產物 `codex-<uuid>/`（attempt worktrees、events/stderr logs、schemas/outputs、snapshot indexes、checkpoint、`result.json`、衝突時的 `result.patch`）放在 `artifactDir(root)` = `os.tmpdir()/model-ladder/<canonical repo 路徑 sha256 前 16 hex>/`（`scripts/common.mjs`；大小寫不敏感平台先轉小寫，canonical 讓 git 與 runner 的 worktree 路徑一致）。`.model-ladder/` 只保留 `runs/`、`history.jsonl`、`HANDOFF.md`、`live.json`、`usage.json`。result paths、`resumeRun`、checkpoint 都用 temp dir。取得 lock 後 `pruneRuns` 刪除該處已完成的 run dir 並取消註冊其 worktree，保留 `CONFLICT`、patch、checkpoint、未完成（無 `result.json`）、作用中鎖提到的 run，`keepFailed` 時也保留仍有 attempt 的 run。舊版留在 `.model-ladder/` 的 run dir 不會被清理。Claude Code runner 的暫存 `state.json`、`setup.patch`、temporary index 在 `.model-ladder/runs/<runId>/`，由 finish 刪除。Test command 來自 trusted config 或 deterministic discovery，verify skills 優先。command check 後另一次 Codex invocation 判 semantic acceptance。editing verifier 是 workspace-write，build artifacts 可產生但 inputs re-check；report-only verifier read-only。沒有 check/acceptance 則 `NEEDS_INPUT`。model output schema-validated；model/auth/sandbox failure stop，不升級。Codex 本身的 usage、rate、quota 錯誤（`codex-exec.mjs` 的 `usageLimitFailure`）以 `errorCode: USAGE_LIMIT` 停止，runner 與 guard 一樣寫 `HANDOFF.md`；文字同時符合 auth/sandbox/model pattern 時仍是一般環境錯誤。入口是 task argument、stdin JSON、`--input <file>`（UTF-8，BOM ok）。README 列 exit codes，沒有 `DIRECT`/`commit`。

`timeoutMs` 是 idle time。SIGINT/SIGTERM/timeout 停 children 並釋放該 run 的鎖，interrupted worker/verifier 保留 draft worktree、checkpoint、`resumeRun`。resume 檢查 commit、dirty snapshot、task、acceptance、config，從 draft fresh worktree re-verify。skill 最多自動 resume timeout 兩次。Guard 在每個 role/verify command 前讀最新 local session 未過期 rate-limit windows，reloading settings；threshold 時回傳含 `errorCode: USAGE_LIMIT`、`handoffPath`、可選 checkpoint 的 `STOPPED`。最高 percentage 計算。`.model-ladder/live.json` atomic replace 為 `{ runId, updatedAt, agents: [{ phase, model, effort, task, startedAt, endedAt, pass }], usage: { fiveHour, sevenDay } }`。ISO strings，active rows 的 `endedAt`/`pass` 為 null，只保存 latest run，SIGKILL 可留 stale active rows。`watch.mjs` 每秒 refresh，10 秒後移除 completed rows，依 cell width 截 task（CJK/emoji aware），sanitize control chars，redirect 時 append frames。300/10080 minutes window 才標 5h/7d，否則 `?`。`--guard`/`--threshold` atomic 更新使用者檔 `~/.codex/model-ladder.json` 並保留其他 fields，不寫專案檔。

## Session、band、測試與效能比較

`hooks/autorun.mjs` 是兩 runtime default-on SessionStart hook，要求將 git repo 的 top-level task 送 ladder，除非使用者 opts out。router 決定 DIRECT/agents，git 外說明需要 repo 後直接工作，roles 不遞迴開 ladder。它受 user/project instructions 約束。`MODEL_LADDER_AUTORUN=0` 或 `autoRun` 關閉，Codex hook 必須信任。`hooks/band.json` 獨立註冊 band，追蹤 agent events、1 s refresh、completed rows 保留 10 s、10 minutes 時通知一次。handler 寫 `.model-ladder/usage.json`，`usage-statusline.mjs` 是 fallback。Claude 的 guard settings 由 preflight 與每次 attempt 後的 verifier 即時讀取（`usage-guard.mjs`），band controls 只編輯使用者檔 `~/.claude/model-ladder.json`，每次操作只改一個欄位。

`worker_skills`/`verifier_skills` 會加至 worker（含 test-writer）與 verifier prompt 的 SKILL INSTRUCTIONS。Claude Code 中它們是 plugin 選項（所有專案的預設），專案可用 `.claude/model-ladder.json` 的同名鍵覆蓋；preflight 合併（必須是字串，否則 `ERROR`）後以 `workflowArgs.skills` 傳給 workflow（見設定）。Codex 在 `.codex/model-ladder.json` 或 `~/.codex/model-ladder.json` 用同 key。band 顯示合併後的值，空值或讀不到時不顯示。nonempty string 原樣傳遞、不解析 commas，仍含 `${` 的值捨棄。角色 model 解讀 conditions、skill-name values，僅在 role scope 內選用可用相關的 skills、plugins、slash commands、MCP tools（名稱可為 skill、plugin 或 MCP server 名）。缺必要能力時報 blocker 並列出已查能力。worker/test-writer/verifier 不設 `tools` allowlist，繼承所有 session 工具（含 MCP）；`disallowedTools: Workflow, Agent` 禁止遞迴與 spawn agent，verifier 內文禁止修改檔案。instructions 不可覆寫 permissions/protected paths/verification rules、讓 verifier fix code 或遞迴 model-ladder。沒有 extra routing call/parser/dependency/config migration。兩 display 都標示 `skill instructions:`，band handoff button 寫 `.model-ladder/HANDOFF.md`。

`node --test tests/unit/*.test.mjs` 是 offline suite，使用 real temporary git repos、scripted fake `agent()`、`tests/helpers/` fake Codex process，涵蓋 `moves`、`flow`、`guard`、`scripts`、`codex*`、`usage-statusline`、`autorun`、`update-check`。最後 full run 是 Linux、Node 22 的 140 passed。`tests/e2e/codex-smoke.mjs` 是 machine-specific real-account test。`node tests/e2e/run.mjs [scenario ...]`（`--dry` 僅 plants/runs pytest）複製 `tests/fixture-repo`、plant problem、以 `claude -p --plugin-dir` 跑 `/model-ladder:run`。11 scenarios 全數 pass，包括 typo、two-files、cheat-bait、add-tests、coupons/cart/shipping、environment、vague/no-verify/dirty，預期是 VERIFIED、STOPPED 或詢問且不執行。

## 效能比較

`node tests/e2e/bench.mjs` 為七任務 x 三策略，以 `uv run pytest` passes 且 existing tests untouched 判定。固定 strategies 收到 `do not modify existing tests; run pytest when done`。結果在 `tests/e2e/bench-results.json`，`bench-results.v1.json` 為 orchestration 移至 scripts 前 first run。2026-10-19，每 pair 一次，以 `claude -p` list price：model-ladder v1 為 6/7、$1.92 total、$0.32 per solved、493 s；model-ladder 7/7、$1.28、$0.18、353 s；sonnet / high 7/7、$0.92、$0.13、133 s；opus / xhigh 7/7、$2.20、$0.31、212 s。相較 opus/xhigh 便宜 42%，haiku low/medium 解完七件；相較 sonnet/high 貴 39% 且較慢。因 orchestration 約 one extra session，成本 $0.18-$0.19。main session 約占 v1 80%（ten calls 重讀約 55k tokens），移入 scripts 後約 70%，context size 視 user plugins 而定。large tasks 未量測，single runs 有 noise。

## End-to-end 經驗與 Codex panel parity（1.8）

run files 放 `.model-ladder/`，因 `.git` 和 `.claude`（headless）不能刪；之後每次 Codex run 的產物（worktree、logs）移到系統 temp dir，不再佔用 repo。pytest 改寫 tracked `.pyc` 曾讓 correct fix 失敗，所以 verifier 忽略 artifact globs。`git add -A -- . ':!.model-ladder'` 在 gitignored path 失敗，先將全部加到 temp index，再 `git rm --cached` own folders。haiku 五次 failed structured output 且 `agent()` throw，throwing agent 是 failed step。無 tests 時 router 曾寫 own assert，因此只允許 pre-existing checks。vague task 曾在 green tests 通過，router 現可先問一題。Windows 經 shell spawn `claude` 會按 spaces 切 task，需 direct spawn 並檢查 question text。

Codex SessionStart hook 提供 persistent PTY watcher 與 desktop terminal visibility 的 setup，明確呼叫 skill 時重複作 fallback。watcher 是 terminal panel，不是 Claude Code UI module，不能顯示在 Codex composer 上方。Codex 管理 hook trust，不可繞過。`autoRun`、`band` 是獨立 project settings。internal role process 繼承 `MODEL_LADDER_ROLE`，停用 panel/autorun setup 避免 recursion。live state 保存 task、input、role skills、retry state、final result。watcher 顯示與 Claude 相同的 phase lights、rounded reset countdowns，接受 guard/threshold/handoff command 後 Enter。handoff 不中斷 active run。兩 runtime 都有 verification-skill generators/maintainers。Codex 產生 `.agents/skills/verify/`，可使用既有 Claude verification skill。
