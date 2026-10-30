# 變更紀錄

[English](CHANGELOG.md)

版本遵循 semantic versioning，Claude Code 更新需提升 `.claude-plugin/plugin.json` 的版本。

## [Unreleased]

## [1.0.2] - 2026-10-30

- 精簡外掛設定註解，並在 Band 選項補上 context window 說明。
- 在第一個設定標籤顯示安裝版本。
- 同步精簡雙語 README、進階使用、設計說明與版本紀錄。
- 更新 Band 範例，將詳細操作與設定參考移至進階文件。
- 移除不可靠的效能比較與過期測試成果宣稱，保留第三方授權原文。

## [1.0.1] - 2026-10-30

- Codex DIRECT 使用呼叫端實測 context 與隔離草稿，通過獨立驗證後才套用。
- Codex 選用 commit 保留無關 staged 變更，跳過含既有或並行修改的檔案。
- Codex SessionStart 遵循個人與專案的 autorun、panel 設定，兩端 test-writer 規則一致。
- 額度交接使用各 run 的 live 狀態，偵測到用量停止時終止其他已註冊 runner 程序樹並寫 `HANDOFF.md`。
- Codex 在 agent 與驗證命令執行中每 2 秒檢查用量。
- 可辨識的純上限訊息視為 `USAGE_LIMIT`。
- Windows 程序樹停止失敗時保留註冊並回報錯誤，不產生錯誤的已停止交接。
- 同步兩端技能與雙語文件，涵蓋 DIRECT、commit、拆分與平台限制。

## [1.0.0] - 2026-10-29

第一個公開版本，包含先前開發歷史。

- 為 Claude Code 與 Codex 任務選模型、隔離嘗試、獨立驗證，失敗時升級。
- Claude 小任務達 `direct_threshold` 時可用 DIRECT，仍須獨立驗證。
- 超過 `split_minutes` 時可選依序分段、整體執行或停止。
- 範圍不重疊的 run 可並行，結果依序套用。
- 用量停止時保留工作並寫 `.model-ladder/HANDOFF.md`，也可用 `/model-ladder:handoff` 手動產生。
- `worker_skills`、`verifier_skills` 選用角色可用能力，缺少時回報。
- 設定依序採用預設值、個人檔（`~/.claude/model-ladder.json` 或 `~/.codex/model-ladder.json`）與專案覆寫。
- Claude Band 顯示角色、用量與 context，Codex HUD 在同一終端顯示狀態。
- Codex 產物放系統 temp，Git 自動排除 `.model-ladder/`、`.claude/worktrees/`。
- 本機驗證只跑相關測試，完整套件由 CI 執行。
- 缺少 Node.js 20+ 時，hooks 顯示安裝需求。
