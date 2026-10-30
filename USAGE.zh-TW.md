# 進階使用

[README](README.zh-TW.md#使用方式) · [English](USAGE.md) · [設計](DESIGN.zh-TW.md)

## 執行報告

報告會用 session 的語言整理任務、嘗試、修改檔案、驗證與剩餘限制。

| 結果 | 意義 |
|---|---|
| `VERIFIED` | 驗證通過，修改任務會套用已驗證的變更。 |
| `DIRECT` | 草稿尚未驗證，需由呼叫端處理後交回獨立驗證。 |
| `DIRTY` | 確認是否以既有未提交變更為基礎執行。 |
| `NEEDS_INPUT` | 補充任務、確認驗收條件、選擇拆分或處理重疊。 |
| `STALE_RUN` | 檢查鎖與程序，確認後再授權清理。 |
| `CONFLICT` | 無法套用 patch，檢查保留的 patch 與 worktree。 |
| `STOPPED` / `FAILED` / `ERROR` | 依回報原因處理阻礙，再決定是否重跑。 |

Claude 用量停止回傳 `USAGE_LIMIT`；Codex 回傳 `STOPPED` 與 `errorCode: "USAGE_LIMIT"`。
執行歷史存於 `.model-ladder/history.jsonl`。

沒有既有驗證命令或 skill 時，提供明確驗收條件，或使用 `create-verification-skill` 與 `maintain-verification-skill`。
Claude 產生 `.claude/skills/verify/`；Codex 產生 `.agents/skills/verify/`，也接受 Claude 路徑。
這些技能改編自 pstack，採 MIT 授權，見 [NOTICE.zh-TW.md](NOTICE.zh-TW.md)。

## Codex runner 與 HUD

| 目的 | 指令 |
|---|---|
| 執行任務 | `node scripts/codex-run.mjs "<task>"` |
| 傳入 JSON | `node scripts/codex-run.mjs --input <file>` |
| 開啟 panel | `node scripts/watch.mjs --cwd <repo>` |
| 啟動 CLI HUD | `npm ci`，再執行 `node scripts/codex-hud.mjs --cwd <repo>`。 |
| 用 HUD 接續 session | 在 HUD 指令後加上 `-- resume`。 |

只有 `VERIFIED` 的 exit code 為 0；`DIRECT`、`DIRTY`、`NEEDS_INPUT`、`STALE_RUN` 為 2，其餘為 1。
也可從 stdin 傳入 JSON；Windows 請使用系統 temp 目錄內的 UTF-8 輸入檔。

Panel 可跨任務重用，無法顯示終端時改看 tool output 的進度。
HUD 必須先啟動 Codex，不能附加到已開啟的 session。
Windows 需使用 PATH 或 `CODEX_BINARY` 指定的原生 `codex.exe`，不接受 `.cmd`、`.bat`。

## 並行執行

| 情況 | 行為或處理方式 |
|---|---|
| 檔案範圍不重疊 | 可跨 Claude 與 Codex 同時執行。 |
| 範圍重疊 | 回傳 `NEEDS_INPUT` 與 `reason: "OVERLAP"`，等另一 run 結束後重試。 |
| 空範圍、純萬用字元或 repo 外路徑 | 視為整個 repo。 |
| 範圍檢查後仍發生衝突 | 保留 patch 與 worktree 供檢查。 |
| 其他 run 留下未提交變更 | 確認 `DIRTY` 後，以其 snapshot 為基礎。 |
| 程序已結束、不可讀或舊版鎖 | 檢查後授權 `--clear-stale` 或 `clearStale: true`。 |
| Claude session 當掉 | 確認已不再執行，再以 `--clear-stale=<runId>` 或 `clearStale: "<runId>"` 清理。 |

不可清除仍有存活程序的鎖；Claude 鎖沒有長駐程序 ID，直到 finish 或確認清理前都視為作用中。
結果一次只由一個 run 套用，guard 會保護所有作用中範圍。
共用的 `live.json`、panel 與 `HANDOFF.md` 顯示最後寫入者，Codex 自動額度交接則使用各 run 的 live 狀態。

## 執行檔案

| 位置 | 內容 |
|---|---|
| `.model-ladder/runs/` | Run 鎖、Claude 暫存狀態、setup patch 與衝突 patch。 |
| `.model-ladder/` | 共用歷史、live、usage、context 與 `HANDOFF.md`。 |
| `<system temp>/model-ladder/<repo hash>/codex-<uuid>/` | Codex worktree、記錄、輸出、snapshot、checkpoint 與 `result.json`。 |

使用 runner 回傳的路徑，不要猜測。
清理會刪除已完成產物，但保留作用中 run、衝突、patch、checkpoint、未完成執行，以及 `keepFailed` 指定的失敗嘗試。

## Codex DIRECT、提交與續跑

| 操作 | 必要步驟 |
|---|---|
| DIRECT | 提供實際 `contextTokens`、`contextWindow`，且 router 須判定為小任務。 |
| 完成 DIRECT | 只修改回傳的 `worktreePath`，再以原始輸入加 `directRun`、`directSummary` 交回。 |
| 強制一般 ladder | 使用 `forceLadder: true`，同時停用拆分建議。 |
| 整體執行大型任務 | 選擇整體執行後，使用 `acceptSplit: false`。 |
| Commit | 明確開啟 `commit: true`，只提交已驗證且不含無關 staged 變更的檔案。 |
| 逾時續跑 | 以原始輸入加回傳的 `resumeRun` 重試，skill 最多自動續跑兩次。 |

DIRECT 不代表完成，必須遵守回傳的保護規則，獨立驗證後才套用。
呼叫端 sandbox 無法修改草稿時，改走一般 ladder，不繞過權限。
續跑會核對原始 checkout、設定、任務與驗收條件，再於新的 worktree 延續草稿。
不可自動續跑取消、額度停止或尚未解決的環境錯誤。
含既有或並行修改的檔案會跳過 commit，跳過或提交失敗時仍保留已驗證的變更並回報 `outcome.note`。
任何 run 都不會 push。

## 進階設定

設定依序採用預設值、個人檔、專案檔，`usageGuard` 逐欄合併。
個人檔為 `~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`，專案檔分別放在 `.claude/`、`.codex/`。

| 設定 | 預設值 | 用途 |
|---|---|---|
| `router` | Claude：`sonnet/low`；Codex：`gpt-5.6-terra/low` | 路由任務與診斷失敗。 |
| `verifier` | Claude：`haiku/low`；Codex：`gpt-6-luna/low` | 獨立檢查結果。 |
| `tiers` | Haiku、Sonnet、Opus；Codex 使用 Luna、Terra、Sol | 依序選模型與 effort，`maxEffortJump` 限制 effort 升幅。 |
| `maxAttempts` | `4` | 最多嘗試次數。 |
| `verify` | 自動尋找 | 既有驗證命令或專案驗證 skill。 |
| `protected` | `[]` | Worker 不得修改的額外路徑。 |
| `commit` | `false` | 明確開啟後提交已驗證變更。 |
| `keepFailed` | `false` | 保留失敗 worktree。 |
| `timeoutMs` | `600000` | Codex 每個角色或驗證命令的閒置逾時。 |
| `usageGuard` | 開啟、`90%` | 使用量保護，建議存於個人檔。 |
| `worker_skills` / `verifier_skills` | 空白 | 自然語言角色指示。 |
| `direct_threshold` | `30` | 小任務 DIRECT 的 context 百分比，或 `"off"`。 |
| `split_minutes` | `20` | 建議拆分的分鐘門檻，或 `"off"`。 |
| `autoRun` / `band` | `true` | 預設路由與顯示開關。 |

Claude 模型別名會使用可用版本，Codex 的模型 ID 與 effort 請依帳戶調整。
Claude 外掛選單提供 DIRECT 門檻 20–80，以及拆分門檻 10、20、30、45、60 分鐘，兩者皆可選 `off`。
未指定 `verify` 時，Codex 優先使用專案驗證 skill，再尋找既有 npm、pytest、Cargo、Go、Maven 或 Make 檢查。

| 環境變數 | 用途 |
|---|---|
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` | 改變個人設定目錄。 |
| `MODEL_LADDER_USER_CONFIG` | 直接指定個人設定檔。 |
| `MODEL_LADDER_AUTORUN=0` | 關閉預設路由。 |
| `MODEL_LADDER_BAND=0` | 隱藏 Codex panel，不影響 autorun。 |
| `CODEX_BINARY` | 指定原生 Codex 執行檔。 |
| `MODEL_LADDER_NO_UPDATE_CHECK=1` | 停用版本檢查。 |

Claude 外掛角色指示作為預設，專案同名鍵可覆蓋，空字串也算覆蓋。
指示必須為字串，空值與未解析的 `${...}` 不加入說明。
可指定 skills、plugins、slash commands 或 MCP server，但不能擴大角色權限、允許 verifier 修改或遞迴呼叫 ladder。
缺少能力時會在執行前及最終報告提醒，例如：`ponytail` 在這個專案無法使用。
`skill instructions:` 顯示的是設定文字，不代表已實際呼叫。

## Band 與 panel 詳細說明

基本欄位與控制項見 [README](README.zh-TW.md#bandclaude-code)。

| 細節 | 行為 |
|---|---|
| Context | Claude 顯示 `ctx 287k/1M (28.7%)`，token 未知時只顯示上限，上限未知則不顯示。 |
| Codex context | 沒有自動資料來源，不可杜撰數值來啟用 DIRECT。 |
| 保護控制 | 只儲存修改的個人設定欄位，專案覆寫仍有效。 |
| 門檻 | 按 Enter 或停止輸入 5 秒後儲存，不會改變保護開關。 |
| Claude 交接 | `handoff now` 先寫模板，再於 session 閒置時提交 `/model-ladder:handoff`。 |
| 交接備案 | 提交失敗時 toast 顯示指令，模板仍可使用。 |
| Codex 控制 | 輸入 `g`、`t 90`、`h` 或 `q` 後按 Enter。 |
| CLI 控制 | `watch.mjs` 接受 `--guard on|off`、`--threshold 1-100`、`--handoff`。 |

手動交接不會取消 run。
Codex 沒有 autorun 或 panel 時，確認外掛已啟用、重新啟動 session，並在 `/hooks` 檢閱與信任 hooks。
明確呼叫 ladder skill 也會初始化 panel，不會安裝 editor UI extension。

## 使用量保護細節

| 條件 | 行為 |
|---|---|
| Claude 用量門檻 | 在 run 前及失敗嘗試後檢查。 |
| Codex 用量門檻 | 在角色切換時及執行中每 2 秒檢查。 |
| 作用中 run 用量停止 | 停止該 run 與同機其他已註冊 runner 的程序樹。 |
| 未知用量 | 不阻擋執行。 |
| 額度硬上限 | 關閉 guard 仍停止，包括可辨識的純上限訊息。 |
| 認證、sandbox 或模型存取錯誤 | 視為環境錯誤停止，不產生額度交接。 |
| Windows 拒絕停止程序樹 | 回報錯誤、保留註冊，不宣稱已停止。 |

不可繞過 sandbox、清除存活鎖，或以單一 PID 取代程序樹停止。
可停止已註冊 runner，不代表能取消任意 Claude 宿主 session 或 hosted agent。
Claude 用量來自 Band 或 `scripts/usage-statusline.mjs`，只有 Pro/Max 方案回報用量。

`USAGE_LIMIT` 會保留可用草稿並寫入 `.model-ladder/HANDOFF.md`。
主 session 在原樣保留的驗證附錄前補上目標、決定、已完成工作、下一步與續跑方式，附錄仍為權威紀錄。
session 無法呼叫模型時保留模板。
強制終止的 run 可能沒有 checkpoint 或 `result.json`，此時檢查草稿並在額度重設後重啟原始任務，不可杜撰 `resumeRun`。
