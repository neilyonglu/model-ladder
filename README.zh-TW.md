<div align="center">

# model-ladder

**為每項任務挑選合適的模型，完成後驗證，通過才交付。**

[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757?logo=claude&logoColor=white)](https://code.claude.com/docs/en/plugins)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991?logo=openai&logoColor=white)](README.zh-TW.md#安裝)
[![release](https://img.shields.io/github/v/release/usio0108/model-ladder?label=release&color=blue)](CHANGELOG.zh-TW.md)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[English](README.md) · [安裝](#安裝) · [使用方式](#使用方式) · [設定](#設定) · [Band](#bandclaude-code) · [使用量保護](#使用量保護) · [效能比較](#效能比較) · [關閉功能](#關閉功能) · [設計](DESIGN.zh-TW.md)

</div>

---

## 功能

model-ladder 是 [Claude Code](https://code.claude.com) 與 Codex 的外掛。Router 會為每項任務挑選合適的模型，Worker 負責執行，Verifier 檢查結果。通過驗證的變更才會交付。

- **隔離的 Git worktree**：每次嘗試各自在獨立 worktree 中執行。
- **適時升級**：驗證失敗時，可能改用更強的模型或提高 effort。
- **配額交接文件**：用量接近設定配額且符合執行條件時，建立 `.model-ladder/HANDOFF.md`。接著由主 session 根據你與它的對話改寫（目標、偏好與決定、已完成／未完成、下一步、續跑方式），並把程式產生的驗證結果保留為附錄。
- **Band / panel**：查看執行中的角色與用量資訊，並可手動建立交接文件（`/model-ladder:handoff`）。
- **自訂角色指示**：`worker_skills` 與 `verifier_skills` 可指定 worker 和 verifier 使用任何目前可用的能力：skills、plugins、slash commands 與 MCP 工具。角色 agent 會繼承 session 的所有工具，但不含 Workflow 與 Agent。

## 安裝

需要 Git 與 Node.js 20 以上（外掛不會自動安裝 Node.js）。請在至少有一個 commit 的 Git repo 中使用；Codex 需先在 `/hooks` 信任外掛 hooks。

請先安裝並登入 Claude Code。若要使用自動化，請確認 Workflow 工具可用。Pro 方案請在安裝外掛前到 `/config` 啟用 Workflow。

```text
# Claude Code
/plugin marketplace add usio0108/model-ladder
/plugin install model-ladder@model-ladder
```

```sh
claude plugin marketplace add usio0108/model-ladder
claude plugin install model-ladder@model-ladder

# Codex CLI 0.160.1+（之後請重新啟動 Codex；需要已登入的原生 `codex`）
codex plugin marketplace add usio0108/model-ladder
codex plugin add model-ladder@model-ladder
```

安裝後重開 Claude Code 即生效，之後的頂層任務會自動走 `/model-ladder:run`。第一次執行時若詢問是否允許 Workflow，選「不再詢問」即可。model-ladder 會自行把 `.model-ladder/` 與 `.claude/worktrees/` 排除在 git 之外（寫入 `.git/info/exclude`），不必手動改 `.gitignore`。更新：`claude plugin update model-ladder@model-ladder`（marketplace 開啟自動更新時會自動進行）。報告會提示新版本，見 [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)。

## 使用方式

Claude Code 使用 `/model-ladder:run <task>`。Codex 請 agent 使用 `model-ladder` skill。在非 git repo 中，agent 會說明需要 repo，並直接處理任務。說「no ladder」可略過。

1. **修正 bug**：`/model-ladder:run Fix the off-by-one in pagination`。先嘗試 haiku/low；測試通過便套用。失敗時 router 改用 sonnet/medium。
2. **建立含測試的功能**：`/model-ladder:run Add a --json flag to the export command, with tests`。任務要求測試時，worker 可編輯測試。否則測試受保護，不能為了通過而變更。
3. **提問或審查（不變更）**：`/model-ladder:run Review src/auth.ts and list risks`。答案在報告中，檔案不會變更。
4. **被 usage guard 停止**：`/model-ladder:run Migrate the settings module to the new config format`。失敗後 5 小時使用量達 90% 時，執行回傳 `USAGE_LIMIT`、保留最後 worktree 並寫入 `.model-ladder/HANDOFF.md`。重設後重跑。
5. **小任務回傳 DIRECT**：`/model-ladder:run Rename the variable tmp to buffer in utils.py`。很長的 Claude session（超過約 300k tokens）中，小任務由本 session 直接完成。之後由 `model-ladder:verifier` agent（設定中 `verifier` 的 model 與 effort）獨立檢查 diff；通過才回報完成，失敗則修正後再驗。加上 `--ladder` 可強制走 ladder。

完成的執行會產生類似下面的報告。Claude Code 與 Codex 讀完後，會用你在這個 session 使用的語言整理成一份摘要回報（狀態、改了哪些檔案、驗證結果、限制與待辦），檔名、指令與路徑保留原文：

```text
model-ladder ── VERIFIED
Task      Fix the typo in the welcome message
Verify    uv run pytest tests/test_messages.py
Tests     protected (router: Bug fix; the existing test defines expected behavior.)
Start     haiku/low (router: One-character typo in shop/messages.py.)

#  Model / Effort   Result   Why next
1  haiku / low      PASS     —

Changed   shop/messages.py
Applied   to the working tree (not committed)
```

Verify 是你的測試命令，每一列是一次嘗試。未提交變更、任務不清楚、沒有測試，或設定 `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 時會先詢問。每次執行記錄在 `.model-ladder/history.jsonl`。沒有 verify step 時，`/model-ladder:create-verification-skill` 會產生 `.claude/skills/verify/`，`/model-ladder:maintain-verification-skill` 會保持它最新。兩者改編自 [pstack](https://github.com/michael-denyer/pstack-claude)，採 MIT 授權。見 NOTICE.md。

直接執行 Codex runner：`node scripts/codex-run.mjs "<task>"`，只有 `VERIFIED` 的 exit code 是 0。Codex desktop 中，session hook 與 ladder skill 會指示 Codex 自動啟動並顯示常駐 terminal panel，可跨任務重用。也可手動執行 `node scripts/watch.mjs [--cwd <repo>]`。沒有 terminal panel 時，runner 會在 tool output 顯示進度。Codex 使用 router `gpt-5.6-terra/low`、verifier `gpt-6-luna/low`，tier 為 Luna、Terra、Sol（以帳戶可用模型替換）；沒有 `DIRECT` shortcut 或 `commit` 選項。

要在 Codex CLI 的同一個終端顯示一行 HUD，請先執行 `npm ci`，再於本專案目錄執行 `node scripts/codex-hud.mjs --cwd <repo>`（接續 session 則加上 `-- resume`）。Windows 需要 PATH 中的原生 `codex.exe`，或以 `CODEX_BINARY` 指定；不接受 `.cmd` 或 `.bat` 啟動器。

同時執行：檔案範圍不重疊的 model-ladder run 可以在同一個 repository 同時執行，不論是 Claude Code、Codex，或兩者各一個。每個 run 持有自己的鎖 `.model-ladder/runs/<runId>.json`（記錄 runtime、pid、protected 與測試 pattern、scope）。router 列出預計修改的檔案後，run 會把這個 scope 與其他作用中的 run 比對：

- 不重疊：兩個 run 都繼續執行。
- 重疊：在任何 worker 開始前停下，回傳 `NEEDS_INPUT`，附 `reason: "OVERLAP"` 與重疊的 run。Claude Code 會問你要不要等待；等另一個 run 結束後再重新認領。Codex 回傳同樣的狀態；另一個 run 結束後以相同 JSON 重新執行。不會覆蓋任何東西。
- 空的 scope、`**` 這類單純萬用字元，或 repo 以外的路徑，都視為整個 repo，因此與所有作用中的 run 重疊。
- 若 router 預估的 scope 有誤、檔案仍被改到，run 照舊得到 `CONFLICT` 並保留 patch。結果一次只由一個 run 寫入你的工作目錄。
- 過期的鎖：process 已不存在的鎖、無法讀取的鎖，或舊版的 `.model-ladder/run.json`，會回傳 `STALE_RUN`。`--clear-stale`（Claude Code）或 `"clearStale": true`（Codex）只會移除這些鎖。Claude Code 的 run 沒有可檢查的長駐 process，因此它的鎖在 finish 移除前都視為作用中。若該 session 已當掉，以 ID 清除它的鎖：`--clear-stale=<runId>` 或 `"clearStale": "<runId>"`。process 仍存活的鎖一律不會被清除。
- 未提交變更：另一個 run 已套用但尚未 commit 的變更，和其他未提交變更一樣，新的 run 仍會詢問（`DIRTY`）。回答可以是安全的：run 會以這些變更的 snapshot 為基礎，且只套用自己的檔案。檢查會等待正在套用的 run 完成，因此不會看到寫到一半的檔案。
- guard hook 同時保護所有作用中 run 的 pattern。`live.json` 與 Codex panel 顯示最後更新的 run，`HANDOFF.md` 為共用。

執行檔案的位置：`.model-ladder/` 只保留小型共用檔案：`runs/`（每個作用中 run 一個鎖，以及 Claude Code run 暫存的 `state.json`、`setup.patch` 與衝突時的 `result.patch`，放在 `runs/<runId>/`）、`history.jsonl`、`HANDOFF.md`、`live.json`、`usage.json`。每次 Codex 執行的 `codex-<uuid>/` 目錄（attempt worktree、events 與 stderr 記錄、schema 與 output、snapshot、checkpoint、`result.json`、衝突時的 `result.patch`）放在系統 temp 目錄的 `model-ladder/<repo 路徑 hash>/` 下，結果中的 `worktreePath`、`checkpointPath` 與 patch 路徑都指向該處。`resumeRun` 從該目錄讀取 checkpoint。新的執行會刪除該處已完成的執行目錄，保留 `CONFLICT`、含 checkpoint 與沒有 `result.json` 的執行。

## 設定

設定分兩層，都可省略。設定的每個 key 會取代下一層的值：

1. **個人**（你自己的、套用所有專案、不會 commit）：`~/.claude/model-ladder.json`（Claude Code；有設 `CLAUDE_CONFIG_DIR` 時為 `$CLAUDE_CONFIG_DIR/model-ladder.json`）或 `~/.codex/model-ladder.json`（Codex；`$CODEX_HOME/model-ladder.json`）。個人習慣放這裡，尤其是 `usageGuard`。`MODEL_LADDER_USER_CONFIG` 可指定其他檔案（測試用）。
2. **專案**（隨 repo commit）：`.claude/model-ladder.json`（Claude Code）或 `.codex/model-ladder.json`（Codex），優先於個人檔。專案若仍寫了 `usageGuard` 欄位，照舊會覆蓋個人設定；建議專案檔不要放 `usageGuard`，讓每個人自己決定。

讀取順序：預設值 → 個人檔 → 專案檔；`usageGuard` 逐欄合併。preflight、workflow 的 guard 檢查、band、Codex runner 與 Codex panel 都用同一個合併函式。

| 設定鍵 | 預設值（Claude） | 意義 |
|---|---|---|
| `router` | `{"model":"sonnet","effort":"low"}` | 選擇起點並診斷失敗 |
| `verifier` | `{"model":"haiku","effort":"low"}` | 執行 verify 命令，沒有命令時由 router model 判斷 |
| `tiers` | haiku low-high, sonnet low-high, opus low-xhigh | 由弱到強的 grid，`maxEffortJump` 限制每次移動的 effort steps（2, 2, 1） |
| `maxAttempts` | `4` | 放棄前的嘗試次數 |
| `verify` | 由 router 找出 | 證明任務完成的命令 |
| `protected` | `[]` | worker 不得修改的額外 glob |
| `commit` | `false` | 提交已驗證的變更，僅 Claude 支援 |
| `keepFailed` | `false` | 保留失敗嘗試的 worktree |
| `usageGuard` | `{"enabled":true,"threshold":90}` | 到 5 小時或每週額度的 `threshold`%（1-100）時停止，欄位可單獨設定。屬個人設定，建議放個人檔 |
| `timeoutMs` | `600000` | 僅 Codex，每個角色或 verify 命令的閒置時間上限 |
| `worker_skills` | `""` | 給 worker 與 test-writer 的 skill／plugin／MCP 工具指示（自然語言字串） |
| `verifier_skills` | `""` | 給 verifier 的 skill／plugin／MCP 工具指示（自然語言字串） |
| `direct_threshold` | `30` | 任務小且呼叫端 session 的 context 佔其 context window 至少此百分比時，由該 session 直接做（數字 1-100，或 `"off"` 表示永不直接做）。Codex 會忽略 |
| `split_minutes` | `20` | router 預估任務超過此分鐘數時，run 會先停下，詢問要分段執行、整個照跑或停止（分鐘數，或 `"off"`）。僅 Claude Code；Codex 會忽略 |

模型為別名（`haiku`、`sonnet`、`opus`），新版本會自動套用。Codex 在 `.codex/model-ladder.json` 也支援 `autoRun`、`band`（boolean，預設 `true`）。`MODEL_LADDER_BAND=0` 會隱藏 Codex panel，但不關閉 autorun。Codex `tiers` 以同樣方式使用 `efforts` 和 `maxEffortJump`。沒有 `verify` 時，Codex 依序使用 `.agents/skills/verify/SKILL.md`、`.claude/skills/verify/SKILL.md`，或既有 npm、pytest、Cargo、Go、Maven、Make 測試命令。

外掛選項（Manage Plugins → Configure model-ladder，或 `/plugin configure model-ladder`，包括 VSCode 的 Claude Code）有預設開啟的 `autoRun` 與 `band`，以及預設空白的 **Worker skill instructions**（`worker_skills`）與 **Verifier skill instructions**（`verifier_skills`），以及 **Direct threshold**（`direct_threshold`：20-80 或 off，預設 30）與 **Split suggestion**（`split_minutes`：10-60 或 off，預設 20）。分層順序：預設值、`~/.claude/model-ladder.json`、專案的 `.claude/model-ladder.json`。

Skill 指示：`worker_skills` 套用到 worker 與 test-writer，`verifier_skills` 套用到 verifier。Claude Code 在外掛選項設定，作為所有專案的預設；專案可在 `.claude/model-ladder.json` 用同名鍵覆蓋（只要專案有該鍵就用專案的，即使是空字串）。Codex 沒有外掛設定介面，請設於 `.codex/model-ladder.json`（或個人的 `~/.codex/model-ladder.json`）。內容為有條件的自然語言說明。名稱可以是 skill、plugin 或 MCP server，角色會對應到可用能力；找不到時回報 blocker 並列出已查過的能力。兩者都必須是字串，其他型別會由 preflight 回報錯誤。workflow 啟動前，主 session 也會把這些名稱與目前 session 可用的能力比對，並提醒你哪些無法使用（例如「`ponytail` 在這個專案無法使用，這次 run 不會用到它」）。run 會照常進行，任何角色回報的能力 blocker 也會在最終報告中再列出。

```json
{
  "worker_skills": "When coding, use ponytail to review and simplify the code.\nWhen working on UI, use available UI/UX skills.",
  "verifier_skills": "When reviewing code, use ponytail to identify simplifications. When checking UI, use available UI/UX skills. Report findings without fixing code."
}
```

兩種 runtime 都會原樣傳遞字串，包括逗號、標點與換行。既有 `ponytail:ponytail` 或 skill-name list 仍可用，不需遷移。現有角色 model 會依任務情境評估條件，僅呼叫實際可用且相關的 skill。需要的 skill 不存在時回報 blocker，不會杜撰已使用。空值與未解析的 `${...}` placeholder 不會加入說明。Skill 不能擴大角色範圍或權限、允許 verifier 修正程式，或遞迴呼叫 model-ladder skill、workflow、runner。Band 顯示合併後的生效值（專案鍵，否則外掛選項），Codex panel 顯示執行中的設定，都標示為 `skill instructions:`；都未設定時不顯示，且不宣稱已呼叫 skill。1.10 版移到 `.claude/model-ladder.json` 的值仍有效，並繼續覆蓋外掛選項。

## Band（Claude Code）

prompt 上方的 band 顯示每個執行中的 ladder agent 與 usage guard。標題前的圓點顯示狀態：🟢 worker 或 router、🔵 verifier、🔴 失敗後重試中的 worker。需要 Claude Code 2.1.290+。

<p align="center"><img src="assets/band.png" width="418" alt="The model-ladder band"></p>

```text
▴ model-ladder ── 2h/5h 15% · 3d/7d 44%
model/effort        time     task
haiku-5.5/low       ✓ 5s     Summarize the README install steps
[usage guard: on]  threshold [90] %
```

header 是 `<time to reset>/<window> <percent>`，後面接 session 的 context window 用量 `ctx <tokens>/<window>`（例如 `ctx 35k/1M`；目前 token 未知時只顯示上限，如 `ctx 1M`），在 Claude Code 回報 session 用量時更新。Codex panel 沒有 context 資料，不顯示。`handoff now` 按鈕會為目前或最後一次執行寫入模板版 `.model-ladder/HANDOFF.md`，接著提交 `/model-ladder:handoff`，讓主 session 根據對話改寫（session 閒置後才執行；若提交失敗，toast 會顯示該命令）。你也可以自己輸入 `/model-ladder:handoff`。`usage guard` 與 `threshold` 寫入你個人的 `~/.claude/model-ladder.json`（不寫專案檔），在下一次檢查就生效，進行中的 run 也一樣。改門檻不會開關 guard。若專案檔固定了該欄位，toast 會提醒該專案仍以專案設定為準。停止輸入 5 秒後或按 Enter 時儲存 threshold。Codex terminal panel 有同樣的狀態色、重設倒數、skill-instructions 行與 guard controls。輸入 `g` 切換 guard、`t 90` 立即儲存 threshold（兩者都寫入 `~/.codex/model-ladder.json`）、`h` 寫入 `.model-ladder/HANDOFF.md`、`q` 關閉 panel，每個命令後按 Enter。CLI 也接受 `--guard on|off`、`--threshold 1-100`、`--handoff`。Handoff 不取消進行中的工作；quota stop 包含續跑所需 checkpoint input。Codex terminal panel 與 Claude prompt 上的 band 分離。

Codex 也安裝 `$create-verification-skill` 和 `$maintain-verification-skill`，建立或維護 `.agents/skills/verify/`。runner 也接受既有 `.claude/skills/verify/`。

若 Codex 沒有 autorun 或顯示 panel，檢查外掛已啟用、更新後已重啟 session，並檢閱或信任 Codex 現行 hook 定義。安裝外掛不會自動信任 hook，見[官方 hook packaging 文件](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)。明確呼叫 model-ladder skill 也會初始化 panel。Codex hooks 不載入 editor UI extension。

## 使用量保護

預設開啟。開關只由你決定：band 的開關、Codex panel 的 `g`（或 `--guard`），或手動編輯設定檔。不論有沒有 run 在跑，其他程式都不會改變它；改門檻也不會改變開關。每次檢查（run 前的 preflight，以及每次嘗試後的 verifier）都讀取當下的設定，所以 run 進行中關掉，該 run 就不會因 guard 停止；打開或調低門檻則在下一次檢查生效。5 小時或每週限制達到 `threshold`（預設 90%）時，不會啟動或在一次失敗後停止，回傳 `USAGE_LIMIT`、保留最後 worktree 並以模板寫 `.model-ladder/HANDOFF.md`；接著主 session 會用你的語言改寫為 AI 撰寫的對話整理，後面附上程式產生的驗證結果附錄（attempt PASS/FAIL、狀態、worktree、續跑命令），附錄仍為權威資料。若 session 已無法再呼叫模型（例如 Codex 撞到硬上限），則保留模板版作為備案。不會中斷執行中的嘗試，未知使用量也不會阻擋。硬上限與 guard 開關無關，關閉時也會停止：在 Claude Code 中，agent 若因訂閱額度真的用完而失敗（例如「You've hit your session limit · resets 3pm」、usage 或 rate limit、HTTP 429），run 會立即停止、不再派下一個 agent，回傳 `USAGE_LIMIT`，原因中帶原始訊息與重置時間；finish 寫出 `HANDOFF.md` 並保留最後一次嘗試的 worktree（包括 worker 來不及回報的那個）。完全沒有錯誤訊息就死掉的 agent 無法與其他失敗區分，仍算一般失敗。在 Codex 中，Codex 本身回報的 usage、rate 或 quota 上限也會以 `USAGE_LIMIT` 停止並寫 `HANDOFF.md`；認證、sandbox 與模型存取錯誤則以環境錯誤停止，不寫交接檔。Claude 使用量來自 band；沒有 band 時使用 `scripts/usage-statusline.mjs` 作 statusline。只有 Pro/Max plan 會回報使用量。

## 效能比較

七個小任務，每個執行一次，以每個解決任務的 list-price cost 計算（Claude Code）：

| 策略 | 完成數 | 每個已完成任務的成本 |
|---|:---:|---:|
| **model-ladder** | 7/7 | **$0.18** |
| always sonnet / high | 7/7 | $0.13 |
| always opus / xhigh | 7/7 | $0.31 |

相較 Opus/xhigh 便宜 42%。小任務相較 Sonnet 較貴且較慢。未衡量大任務。詳見 [DESIGN.zh-TW.md](DESIGN.zh-TW.md#效能比較)。

## 關閉功能

| 功能 | 方法 |
|---|---|
| 預設使用 ladder | `/plugin configure model-ladder` 將 **Use the ladder by default** 關閉，或使用 `MODEL_LADDER_AUTORUN=0` |
| Band | 關閉 **Show the band** |
| Usage guard / threshold | 使用 Band controls、Codex panel 的 `g` / `t 95`，或在個人的 `~/.claude/model-ladder.json`、`~/.codex/model-ladder.json` 寫 `{"usageGuard":{"enabled":false}}` / `{"usageGuard":{"threshold":95}}` |
| 整個外掛 | `claude plugin disable model-ladder@model-ladder` |

## 開發

Offline suite：`node --test tests/unit/*.test.mjs`。End-to-end：`node tests/e2e/run.mjs [--dry]`。

設計與經驗：[DESIGN.zh-TW.md](DESIGN.zh-TW.md)。[MIT License](LICENSE)，(c) 2026 usio0108。問題請[建立 issue](https://github.com/usio0108/model-ladder/issues)。

變更任一語言版本時，請在同一變更中更新其英文與繁體中文對應版本。
