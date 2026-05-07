# Lynn v0.77.8 Release Notes

> 发布日期: 2026-05-06 · 代号: "HTML Artifact Recovery"

v0.77.8 是一次面向长报告、HTML/Word 产物和输入体验的稳定性更新。重点修复“模型已经生成 HTML 但聊天框没有展示”“多行文本粘贴丢失”“伪工具提示反复打断用户”等问题，同时补齐 V9 benchmark 到正式测试目录。

## 重点更新

### HTML 报告与 Artifact
- 修复 `create_artifact` / `create_report` 工具已经生成 HTML，但缺少 tool result 时聊天框不显示卡片的问题。
- 历史会话重新加载时会从 assistant tool call 中恢复 HTML Artifact，不再让长报告“消失在工具调用里”。
- 已生成的 HTML Artifact 会按标题、类型、内容去重，避免重复卡片刷屏。

### Word / DOCX 附件
- 新增 `create_docx` 工具，支持把调研报告、长文分析等内容直接生成 `.docx` 附件。
- 当用户明确要求“生成 Word / DOCX / 文档附件”时，Lynn 会在 turn 结束时自动补发可下载的 Word 文件，避免只给正文、不出附件。
- 修复工具成功后只出现“模型没有整合出最终文字”的低价值兜底，改为更清晰的“操作已完成”提示，并对重复文件附件做去重。

### 输入与复制体验
- 修复多行内容粘贴到 Lynn 输入框时被吞或只保留部分内容的问题。
- 修复部分环境下 `navigator.clipboard` 不可用导致复制按钮失败的问题，增加 textarea fallback。
- 移除执行型任务的低价值提示噪音，让用户更直接看到执行结果。

### 伪工具调用收口
- 本地桥接和普通 session 不再用额外 prompt 强制模型重试伪工具调用，避免形成“提示词互怼”和死循环。
- 发现模型把工具调用写成普通文本时，只做泄漏清洗和上层兜底，保持 Brain “模型自主决定是否调用工具”的原则。
- 修复零干预改造中遗留的 `retry = null` 崩溃风险。

### 测试与发布基线
- V9 benchmark 资料、runner 和复核材料已进入 `tests/benchmarks`，便于后续统一门禁和对比评估。
- 增加 Artifact recovery 单测，覆盖 JSON 参数、HTML 推断、去重和无效输入。

## 回归结果

- Targeted tests: `chat-route-events` / `artifact-recovery` / `report-tool-editorial` / `sanitize-html-artifact` / `generated-tools` 全过。
- DOCX 真实链路: 本地 Lynn.app WebSocket 生成 `老年用户内容App调研报告.docx`，附件事件去重为 1 份，`mammoth` 可读取正文。
- TypeScript: `tsc --noEmit` 通过。
- Lint: `npm run lint` 0 errors。
- Release gate 与打包验证请以本次发布流程产物为准。

## 下载

- macOS Apple Silicon: `Lynn-0.77.8-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.8-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.8-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.8

## 升级建议

建议所有 v0.77.x 用户升级。该版本不包含破坏性数据迁移，安装覆盖后会继续沿用原有会话、模型配置和本地数据。
