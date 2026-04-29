# Lynn v0.77.0 Release Notes

> 发布日期: 2026-04-29 · 代号: "Regression Gate"

v0.77.0 是一次以稳定性、回归门禁和发版可靠性为核心的版本。重点不是继续堆新功能,而是把这几天 dogfood 暴露出的 UI、工具调用、空答、回退路径和发版流程问题系统性收口,降低"刚发版就热更新"的概率。

## 重点更新

- 新增发布级回归门禁: 覆盖工具调用、文件操作、设置页、模型路由、流式事件、空答兜底和 UI smoke。
- 新增 V8 持久 WebSocket 基准测试: 单连接串行跑完整题集,避免每题重连导致 retry/stream 状态丢失。
- 强化工具调用后处理: 工具成功但模型不给最终文本时,自动生成可见兜底回答;工具失败且只有开场白时,强制转入无工具重答。
- 增加 internal retry 硬超时: retry 卡住时会自动 abort、发 `turn_end/status:false`,避免后续 prompt 被 "Lynn 还在说话" 污染。
- 修复内容过滤误伤: 短英文敏感词不再命中普通英文单词内部,例如 `sm` 不会再拦截 `small`。
- 拆分 `server/routes/chat.js`: 把流式清洗、stream state、内部 retry、预取上下文拆到独立模块,降低后续改动风险。
- 统一 WebSocket 协议定义: ServerEvent / ClientEvent 有共享协议源和 contract test,减少事件改名后 UI 静默退化。
- 增强启动和 UI 初始化状态: 更早提供 health/readiness 信号,减少冷启动时"像打不开"的体感。
- 优化渲染端加载路径: Markdown、Mermaid、编辑器等重模块继续按需加载,降低首屏压力。
- 收敛 React Hook 依赖告警: 核心 UI stale closure 风险已大幅降低。
- 自动化发版辅助: 更新 manifest、DMG 命名、preflight 检查和镜像站同步流程。

## 回归结果

- Unit/Integration: 808/808 pass
- TypeScript: 0 errors
- ESLint: 0 errors
- Release Regression: 13/13 pass
- V8 Persistent Gate: 34/34 pass
- V8 慢响应 warning: 6 个,主要集中在 retry/实时工具链路;不阻塞发版,后续继续优化 TTFT。
- 内容过滤性能: 100000 次短输入检查约 115.7ms,平均约 0.0012ms/次

## 下载

- macOS Apple Silicon: `Lynn-0.77.0-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.0-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.0-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.0

## 升级建议

桌面客户端可以直接安装覆盖。v0.77.0 没有破坏性配置迁移;如果你已经在使用 v0.76.x,升级后原有会话、模型配置和本地数据会继续沿用。
