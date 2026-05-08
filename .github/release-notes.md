# Lynn v0.77.10 Release Notes

> 发布日期: 2026-05-08 · 代号: "Tool Recovery Gate"

v0.77.10 是一次面向真实用户场景的热修版本。重点修复 Brain 伪工具输出导致天气、行情和本地任务“看起来在调用工具但没有真实执行”的问题，同时把 Brain v2 的 verifier / deep-research / agent checkpoint 镜像代码同步进仓库，方便后续从热修验证转为正式资产。

## 重点更新

### 工具调用与实时数据
- 新增只读伪工具恢复层：当 Brain 把天气、行情等工具写成 `<tool_call>` 文本时，Lynn 会改走真实 `weather` / `stock_market` 工具，并输出带时间戳和依据的可见结果。
- 修复 release gate 中 FENCE / TOOL 场景的假阳性：天气、AAPL / TSLA 行情和伪工具泄漏用例均已通过真实 live 回归。
- 保持本地写入、删除、移动任务的安全边界：只读恢复不会绕过授权卡片，也不会自动执行危险操作。

### Brain v2 资产同步
- 将 Brain v2 mirror 纳入仓库：包含 provider registry、router、wire adapters、tool exec、verifier middleware、deep-research、agent checkpoint 和配套测试。
- Deep Research 增加质量地板：低质量 winner 不再直接输出，避免把不稳定候选答案当成最终结论。
- verifier 默认禁用 DeepSeek thinking，降低评估延迟，并以 fail-open 方式避免阻塞用户主链路。

### 桌面稳定性与安全
- 加固 Electron IPC sender 校验，降低非主窗口 webContents 调用写敏感 IPC 的风险。
- 增加 server heartbeat 自动恢复，内嵌 server 卡死或不可复用时会主动重启并通知前端重连。
- 自动更新继续使用腾讯镜像下载资产，国内用户不再依赖 GitHub 二进制下载速度。

## 回归结果

- Unit tests: `1404 passed / 1 skipped`
- Brain v2 mirror tests: `141 passed`
- Focused chat route events: `43 passed`
- TypeScript: `tsc --noEmit` 通过
- Lint: `npm run lint -- --quiet` 通过
- Release regression: `0 failed / 0 blocker / 0 critical`

## 下载

- macOS Apple Silicon: `Lynn-0.77.10-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.10-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.10-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.10

## 升级建议

建议所有 v0.77.x 用户升级。该版本不包含破坏性数据迁移，安装覆盖后会继续沿用原有会话、模型配置和本地数据。
