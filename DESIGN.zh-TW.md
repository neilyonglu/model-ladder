# model-ladder 設計

[README](README.zh-TW.md) · [進階使用](USAGE.zh-TW.md) · [English](DESIGN.md)

## 目標

選擇合適的模型與 effort，獨立驗證、保留既有工作，只套用通過驗證的變更。
Claude Code 使用 Workflow，Codex 使用獨立 Node runner。

## 模組

| 模組 | 職責 |
|---|---|
| `skills/run/` | Claude 前置檢查、路由、詢問、workflow 與收尾。 |
| `codex-skills/model-ladder/` | Codex runner 初始化與結果處理。 |
| `workflows/ladder.js` | Claude 協調流程與升級規則的原始來源。 |
| `scripts/preflight.mjs`、`claim.mjs`、`finish.mjs` | 驗證、snapshot、認領範圍、套用與清理。 |
| `scripts/codex-run.mjs` | Codex 路由、嘗試、驗證、診斷與套用。 |
| `scripts/codex-exec.mjs`、`codex-worktree.mjs` | 子程序、schema 與 worktree 安全。 |
| `scripts/runs.mjs` | 共用鎖、範圍檢查與套用 mutex。 |
| `hooks/config-layers.mjs`、`scripts/config.mjs` | 設定合併與 Node 檔案存取。 |
| `hooks/guard.mjs` | 提前阻擋 worker 修改受保護路徑。 |
| `scripts/usage-guard.mjs` | 用量檢查與已註冊 runner 的停止。 |
| `hooks/band/`、`scripts/watch.mjs`、`codex-hud.mjs` | Claude Band 與 Codex 終端顯示。 |
| `scripts/sync-rules.mjs` | 從 workflow 純函式產生 `scripts/ladder-rules.mjs`。 |

## 角色與流程

| 角色 | 職責與限制 |
|---|---|
| Router | 選擇起點、範圍、驗證方式與合法下一步。 |
| Worker | 在隔離 worktree 完成一次嘗試，不修改受保護輸入。 |
| Test-writer | 處理明確要求的測試變更，遵守相同 worker 限制。 |
| Verifier | 獨立檢查 diff 與驗收條件，不修正程式。 |
| 主 session | 處理詢問、DIRECT、摘要與交接情境。 |

Claude Router 僅有 Read、Grep、Glob；worker 與 verifier 繼承可用工具但禁用 Workflow、Agent，且 verifier 不得寫檔。
Codex 角色使用明確模型、schema、暫時 session，以及既有 sandbox 與核准控制。

```text
檢查 -> snapshot -> 路由 -> 認領範圍 -> worker -> verifier -> 套用
                                       ^          |
                                       +-- 診斷失敗
```

- Claude 依序使用 `preflight.mjs`、路由 Workflow、`claim.mjs`、執行 Workflow 與 `finish.mjs`。
- Codex 在 `codex-run.mjs` 內負責相同階段。
- 必須有既有檢查或明確的使用者驗收條件，router 不得自創檢查或核准。
- 修改測試需使用者要求，結果通過驗證後才套用。
- 一般重試從原始 snapshot 開始，只帶入前次摘要與提示，不延續失敗程式。

## 設定與角色指示

設定順序為預設值、個人檔、專案檔，`usageGuard` 逐欄合併。
個人檔為 `~/.claude/model-ladder.json` 與 `~/.codex/model-ladder.json`，完整選項見[進階設定](USAGE.zh-TW.md#進階設定)。
Claude 外掛的 `worker_skills`、`verifier_skills` 併入個人層，專案同名鍵可覆蓋，空字串也算覆蓋。

共用的 `projectSkills` 在合併設定後比對主 repo 資料夾前綴，保留無前綴的全域規則，執行與顯示前只移除第一個冒號前綴。
選中的指示保留內容與角色限制，可用性檢查與最終報告只處理適用能力的 blocker。
`usageGuard.enabled` 只由使用者明確操作改變，門檻修改只寫個人欄位且保留開關。
專案覆寫仍有效，guard 變更不會使 Codex checkpoint 失效。

## 升級規則

| 移動 | 規則 |
|---|---|
| 提高 effort | 同 tier，受 `maxEffortJump` 限制。 |
| 提升模型 | 只到下一 tier，可選其合法 effort。 |
| Router 選擇無效 | 下一個 effort，否則下一 tier 的最低 effort。 |
| 環境問題或任務不清 | 停止並回報阻礙。 |

`legalMoves`、`pickMove` 來自共用產生規則，測試會檢查是否偏離來源。
Worker 死亡或輸出無效算該步驟失敗，診斷失敗使用預設合法移動。
Codex 的認證、模型存取與 sandbox 錯誤直接停止，不升級重試。

## 隔離與並行執行

| 機制 | 保證 |
|---|---|
| 暫存 Git index | Snapshot 包含已提交、dirty 與未追蹤輸入，不改使用者 index。 |
| `baseTree` 差異 | 只套用該次嘗試的變更，保留原始 snapshot。 |
| 各 run 鎖 | 記錄 ID、runtime、程序、保護規則與認領範圍。 |
| 範圍 registry mutex | 阻止重疊認領同時通過。 |
| 套用 mutex | 序列化套用、commit、dirty 檢查與 snapshot。 |
| 衝突結果 | 無法套用時保留 patch 與 worktree。 |
| Worktree 所有權 | 只清理該 run 產物，保留需要的草稿。 |

範圍以保守的正規化路徑前綴判斷，空值、無效範圍或純萬用字元視為整個 repo。
唯讀 run 不認領修改範圍，尚未認領的 run 在認領時再比對。
程序死亡或鎖不可讀視為過期，Claude 鎖沒有長駐 PID，當掉後需確認才能清理。
不可清除存活程序的鎖或其他作用中 run 的 worktree。
共用 `live.json`、panel、`HANDOFF.md` 由最後寫入者覆蓋，Codex 額度交接另存各 run 的 live 狀態。

## 保護輸入

| 層次 | 檢查 |
|---|---|
| Claude PreToolUse hook | 有 run 鎖時提前阻擋 worker 修改受保護路徑。 |
| Verifier diff | 檢查實際 tracked、untracked 變更，包括 shell 修改。 |
| Codex 驗證 | 保護設定、測試、選定驗證 skill、npm script/config 與相關 build manifest。 |

任務未要求修改測試時，測試維持保護；明確指定的 `protected` 路徑一律禁止修改。
驗證可產生 build artifact，但既有 tracked 輸入仍會檢查。
Hook 屬提前防護，Node 不可用時放行，最終 diff 檢查仍執行保護。

## DIRECT、拆分與續跑

| 功能 | 規則 |
|---|---|
| DIRECT | 小任務且實測 context 達 `direct_threshold`，路由決定本身不等於通過驗證。 |
| Claude DIRECT | 主 session 修改後交獨立 verifier，最多三輪修正。 |
| Codex DIRECT | 呼叫端修改隔離草稿，`directRun` 再認領範圍、核對基線、驗證及套用。 |
| 拆分 | 超過 `split_minutes` 時，由使用者選依序分段、整體執行或停止。 |
| 強制 ladder | `forceLadder` 停用 DIRECT 與拆分建議。 |
| 逾時 | `timeoutMs` 限制沒有輸出的閒置時間。 |
| Codex 續跑 | 核對 checkout、任務、驗收與設定，再以新 worktree 延續草稿。 |

Codex skill 最多自動續跑逾時兩次，不自動續跑額度停止或取消。
不假設有自動 Codex context 資料，無法存取草稿時也不可繞過 sandbox。
選用 commit 排除無關 staged 變更，含既有或並行修改的檔案會跳過，任何 run 都不 push。

## 用量停止與交接

- Claude 在 run 前與失敗嘗試後檢查，Codex 在角色切換與執行中每 2 秒檢查。
- 額度硬上限與可辨識的純上限訊息會以 `USAGE_LIMIT` 停止，不受 guard 開關影響。
- 作用中的用量停止也會終止同機其他已註冊 runner 的程序樹。
- Windows 停止失敗時保留註冊並回報阻礙，不產生錯誤的已停止交接。
- 已註冊程序的控制不代表有 API 能取消任意 Claude hosted agent。
- 強制終止的草稿可能沒有 checkpoint，不可杜撰 `resumeRun`。

`/model-ladder:handoff` 與自動額度交接會寫 `.model-ladder/HANDOFF.md`。
主 session 在原樣保留的驗證附錄前補上對話情境，附錄仍為權威紀錄。
無法再呼叫模型時保留模板，手動交接不取消工作。

## 儲存、顯示與平台限制

| 項目 | 行為 |
|---|---|
| Claude run 檔案 | 鎖與暫存狀態放在 `.model-ladder/runs/`。 |
| Codex 產物 | `artifactDir(root)` 將 worktree、記錄、checkpoint 與結果放在系統 temp 的 `model-ladder/<repo hash>/`。 |
| 共用紀錄 | `.model-ladder/` 保存歷史、live、usage、context 與交接。 |
| 清理 | 保留作用中 run、衝突、保留 patch、checkpoint 與未完成草稿。 |
| Autorun | SessionStart 指示受使用者與專案規則約束，Codex 須信任 hooks。 |
| 內部角色 | 關閉遞迴 autorun 與 panel 初始化。 |
| Claude Band | 事件驅動的任務列、context 量測、保護與交接控制。 |
| Codex 顯示 | Terminal panel 或 HUD，沒有 Claude 原生 UI 或自動 context 量測。 |

角色程序不會取得父對話的私人情境，也不能使用子宿主未提供的工具。
顯示每秒更新，完成列保留 10 秒。

## 驗證與發布

- 本機只跑相關測試，CI 執行 `node --test tests/unit/*.test.mjs`。
- 離線 harness 使用暫存 Git repo 與 fake 模型邊界，只證明控制流程，不代表認證、模型品質或 hosted UI 已通過。
- 真實帳戶檢查另用 `tests/e2e/codex-smoke.mjs` 與 `tests/e2e/run.mjs`。
- `scripts/update-check.mjs` 每日快取版本檢查，失敗不打擾使用者，`MODEL_LADDER_NO_UPDATE_CHECK=1` 可停用。
- 保持外掛名稱與版本一致，同步兩份 changelog，發布 tag 使用 `vX.Y.Z`。
- CI 要求 release 後的外掛變更提升版本，純文件變更不需提升。
