# Lynn v0.77.11 Release Notes

> 发布日期: 2026-05-09 · 代号: "Deep Research Entry"

v0.77.11 把 Brain v2 的 Deep Research 从后端试验能力推进到 Lynn 桌面客户端的可体验入口。用户现在可以在输入框底部直接开启“深研”，由多模型并行生成候选答案，再经过质量复核后输出；低质量 winner 会被拒绝，不再把不稳定答案直接展示给用户。

## 重点更新

### Deep Research 桌面入口
- 新增输入框底部 `深研` 按钮：空输入时展示功能引导，有输入时直接发起 Deep Research。
- Deep Research 会并行调用候选模型，并在结果尾部显示质量复核状态、winner 和候选评分。
- 针对 `A3B` 这类容易误判的缩写问题加入质量地板，低质量答案会明确拒绝，而不是伪装成结论。

### 会话持久化与本地体验
- `/api/deep-research` 支持 `sessionPath`，通过客户端触发的深研结果会写入本地会话 JSONL。
- 修复“前端看到了结果，但切会话/重载后丢失”的持久化缺口。
- 保留普通聊天链路不变：Deep Research 是显式入口，不会抢占默认模型的日常问答。

### Brain v2 mirror 与测试
- Brain v2 `deep-research` mirror 同步质量地板和失败路径测试。
- 新增 `server/routes/deep-research.js`，把远端 Deep Research 能力封装成桌面端可调用 API。
- Tool-abstain / Qwen3.5 vs Qwen3.6 相关 benchmark 文件归档到 `tests/benchmarks/`，便于后续复现实验。

## 回归结果

- Deep Research route tests: `11 passed`
- Brain v2 Deep Research tests: `12 passed`
- TypeScript: `tsc --noEmit` 通过
- Renderer build: `vite build` 通过
- Release static smoke: `38/38 passed`
- 本地真实 UI：`深研` 按钮点击、质量复核、结果展示、会话持久化均已验证

## 下载

- macOS Apple Silicon: `Lynn-0.77.11-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.11-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.11-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.11

## 升级建议

建议希望体验 Deep Research 的用户升级。该版本不包含破坏性数据迁移，安装覆盖后会继续沿用原有会话、模型配置和本地数据。
