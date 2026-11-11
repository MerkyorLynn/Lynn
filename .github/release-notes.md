# Lynn v0.87.6 · Live Compaction 与长会话稳定性

[国内下载说明页](https://download.merkyorlynn.com/download.html)

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.6-macOS-arm64.dmg)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.6-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.6-Windows-Setup.exe)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.6.tgz"
Lynn --version
```

### V0.87.6 重点更新

- **Live Compaction Spine**：为超长工具结果增加本地原文备份、SHA256 校验和追加式投影，原始会话 JSONL 不被改写。
- **安全边界**：只处理完整工具调用轮次，保留最近三轮，遇到备份或元数据校验失败自动跳过；失败工具保留完整诊断，空官方摘要不推进压缩；默认关闭，使用 `LYNN_LIVE_COMPACTION=1` 启用。
- **异步捕获**：GUI 和 CLI 使用会话级串行备份队列，回答事件不等待历史扫描；提交前重新校验分支、checkpoint floor 和原文哈希，分支变化时安全放弃本次投影。
- **GUI / Bridge 长会话**：普通完成回答、工具失败和 fallback 路径统一记录 turn、tool round 与失败信息，支持重启后恢复投影。
- **CLI 适配**：CLI 复用同一规划器和备份校验，运行中按环境变量启用；CLI 会话持久化仍保留原有格式。
- **模型与语音延续**：GUI / CLI 默认工作模型为 Step 5 Preview，实时语音为 `stepaudio-2.5-realtime`，本地推荐 Coder390 Q2 / Q3。

### V0.87.6 Highlights

- **Live Compaction Spine:** preserve long tool results in verified local backups with SHA256 metadata and append-only session projections.
- **Fail-closed boundaries:** compact only complete tool-call rounds, keep the newest three rounds, skip the patch when backup or metadata verification fails, preserve failed-tool diagnostics, and reject empty official summaries.
- **Async capture:** GUI and CLI use a session-scoped serial backup queue; the answer event does not wait for a historical scan, and the patch rechecks the branch, checkpoint floor, and raw hashes before commit.
- **Long-session stability:** unify turn, tool-round and failure metadata across normal, fallback and tool-error paths; projections survive restart.
- **CLI adapter:** reuse the planner and verified backup store behind `LYNN_LIVE_COMPACTION=1` while retaining the existing CLI session format.
- **Current defaults:** Step 5 Preview for ordinary GUI/CLI work, `stepaudio-2.5-realtime` for realtime voice, and Coder390 Q2 / Q3 for local tiers.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.6)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.6)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.6)
