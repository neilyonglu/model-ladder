# 變更紀錄

[English](CHANGELOG.md)

版本遵循 semantic versioning，Claude Code 更新需提升 `.claude-plugin/plugin.json` 的版本。

## [Unreleased]

## [1.1.0] - 2026-10-30

- 耗時預估：耗時範圍、階段計時與各用量時間窗的餘額評估記錄於 live、result、history JSON，並以可比較的成功紀錄校準；移除拆分詢問。
- Claude Code band 與 Codex 面板的時間欄顯示「經過/預估」（例如 `5s/12m`），沒有預估時只顯示經過時間。
- 開跑預估顯示某個用量時間窗不足或有風險時，Claude Code 與 Codex 會在 worker 開始前詢問一次（`acceptUsageRisk: true` 為繼續）；用量保護照常生效。
- 主 session 在 agent 之間持有 run 時（preflight、詢問、finish），Claude Code band 顯示 `no model` 列，不再顯示 `idle`。
- band 將 `.model-ladder` 狀態寫到 repo 根目錄，不再寫到 shell 目前所在的子資料夾。
- Codex 用量保護在角色執行期間可讀到即時用量；即使 stderr 有 sandbox 警告，Codex 用量上限錯誤也會寫出 `HANDOFF.md`。
- 像 `use ponytail:ponytail` 這類含冒號的行維持全域；只有 `專案名稱: ` 前綴才會限定角色指示。

## [1.0.3] - 2026-10-30

- 支援 `專案名稱: 指示` 限定角色指示，無前綴的行維持全域適用。
- Band 只顯示適用指示，移除 `skill instructions:` 標籤，並提供可收合的單行預覽。
- Claude Code、Codex 與 linked worktree 使用相同專案比對規則。

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
