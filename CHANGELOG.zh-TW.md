# 變更紀錄

[English](CHANGELOG.md)

model-ladder 的所有重要變更。版本遵循 [semantic versioning](https://semver.org)。Claude Code 僅在 `.claude-plugin/plugin.json` 的 `version` 改變時提供更新。

## [Unreleased]

## [1.0.0] - 2026-10-29

第一個公開版本。先前的開發歷史已合併進這個版本。

- **Claude Code 與 Codex 的模型階梯。** router 選擇最可能成功的最便宜 model 與 effort。每次嘗試在獨立的 Git worktree 執行，由獨立的 verifier 檢查，失敗時升級到更強的 model 或更高的 effort。驗證通過的改動套用到工作目錄，不會 commit。
- **直接處理。** 任務小、且 session 的 context 已達 window 的 `direct_threshold` 百分比（由 band 實測）時，由本 session 直接處理，仍會經過驗證。
- **拆分建議。** router 預估任務所需分鐘數。超過 `split_minutes` 時提出可各自驗證的子任務，由你選擇依序分段跑、整個照跑或停止。
- **同時執行。** 檔案不重疊的 run 可以同時進行，Claude Code、Codex 或兩者之間都可以。結果依序套用。
- **用量保護與交接。** guard 在用量達門檻時停止 run，開關只由你決定。遇到 `USAGE_LIMIT`（包括 Claude 的訂閱硬上限）時，finish 寫出 `.model-ladder/HANDOFF.md`，主 session 再依對話改寫。也可用 `/model-ladder:handoff` 手動產生。
- **角色指示。** `worker_skills` 與 `verifier_skills` 讓 worker 與 verifier 使用任何 skill、plugin、slash command 或 MCP 工具。指定的能力在專案中無法使用時會提醒。
- **分層設定。** 預設值 → 使用者檔（`~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`）→ 專案檔。Claude Code 也會讀取外掛設定介面（Configure model-ladder）。
- **Band 與 HUD。** Claude Code 的 band 顯示每個 run 的進行中角色、用量與 context（`ctx 287k/1M (28.7%)`）。Codex CLI 的 HUD 在同一個終端的 Codex 下方顯示一行狀態。
- **保持 repo 乾淨。** 執行產物放在系統 temp，每次 run 會把 `.model-ladder/` 與 `.claude/worktrees/` 加入 `.git/info/exclude`。
- **針對性驗證。** router 選的驗證指令只跑與改動相關的測試，完整套件由 CI 執行。
- **Node.js 檢查。** 缺少 Node.js 20 以上版本時，hooks 會顯示安裝提示。
