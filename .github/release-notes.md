# Lynn v0.77.9 Release Notes

> 发布日期: 2026-05-07 · 代号: "Research Synthesis Gate"

v0.77.9 是一次面向深度调研、DOCX 产物和 turn 状态稳定性的补丁版本。重点修复“多轮调研只输出继续深挖”“DOCX 文档没写完也生成附件”“Brain 伪工具泄漏后静默空答”等问题，同时把 chat route 中的 timer 清理逻辑迁入 `stream-state`，为后续继续拆分 `chat.js` 打基础。

## 重点更新

### 深度调研与 Brain v2
- Brain v2 多轮调研任务在达到工具轮次预算、或多轮后仍只生成短进度说明时，会进入禁工具合成轮，避免把“继续整理/继续深挖”当最终回答。
- 调研链路新增研究拆题、证据账本、来源片段和日期线索，方便最终报告合成时保留可追溯依据。
- `parallel_research` 改为尽早聚合可用结果，减少等待慢源拖满预算的情况。

### DOCX 报告质量
- `create_docx` 增加内容质量门禁：过短正文、进度占位语、悬挂 Markdown 表格、明显未完成报告都会被拒绝生成。
- 自动 DOCX 逻辑从 `chat.js` 迁出，由 DOCX 工具模块负责质量判断与附件产出，降低 chat route 复杂度。

### Brain / 非 Brain 行为分层
- Brain 模型跳过浅层本地预取，避免本地预取资料抢占上下文，让 Brain v2 自己做证据收集和工具决策。
- Brain 伪工具泄漏后给用户可见兜底说明，不再静默吞掉；非 Brain 模型继续保留原有伪工具恢复策略。

### Turn 状态稳定性
- 将 `silentBrainAbortTimer`、`turnHardAbortTimer`、tool finalization、授权轮询、持久化轮询等 timer 清理函数统一迁入 `stream-state`。
- `resetCompletedTurnState()` 复用同一个 `clearTurnTimers()` 出口，减少 retry、turn_end、stale stream release 三条路径的重置漂移。

## 回归结果

- Unit tests: `1209 passed / 1 skipped`
- Focused chat route events: `41 passed`
- TypeScript: `tsc --noEmit` 通过
- Lint: `npm run lint -- --quiet` 通过
- Release regression 与 UI smoke 已纳入本次发版门禁

## 下载

- macOS Apple Silicon: `Lynn-0.77.9-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.9-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.9-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.9

## 升级建议

建议所有 v0.77.x 用户升级。该版本不包含破坏性数据迁移，安装覆盖后会继续沿用原有会话、模型配置和本地数据。
