# Lynn v0.77.4 Release Notes

> 发布日期: 2026-05-01 · 代号: "Compact Voice & Tool Stability"

v0.77.4 是一次语音交互与工具执行稳定性补丁。重点修复语音浮层过大、语音中断状态机、ASR 兼容、伪工具/坏 bash 兜底、文件任务反馈和实时数据证据不足等问题。

## 重点更新

- 语音浮层改成轻量小波形卡片：不再显示大块转写/回复卡片，减少闪动和对输入区的遮挡。
- 修复语音中断状态：THINKING/SPEAKING 阶段中断不再崩溃，旧 turn 不会继续阻塞下一轮录音。
- 修复 ASR 链路兼容：Qwen3-ASR 增加语言归一、WAV MIME 识别和请求超时，失败时会清理“理解中…”占位。
- 加固本地工具执行：继续修复伪工具标签、坏 bash 片段、文件移动/删除后无反馈、危险操作授权和结果收尾。
- 加固实时数据：天气、行情、金价等场景必须基于有效字段输出，避免把首页导航或空搜索结果当证据。
- 翻译与报告体验：补齐聊天内翻译入口、HTML artifact 安全渲染与 PNG 导出链路。
- 运行时稳定性：补齐 voice websocket、fallback orchestrator、self-interrupt tracker、release regression 等测试覆盖。

## 回归结果

- Unit / Integration：已通过
- Voice Runtime 专项：已通过
- TypeScript / Lint：已通过
- Renderer / Main / Server build：已通过
- 本地 DMG 冷启动：已通过

## 下载

- macOS Apple Silicon: `Lynn-0.77.4-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.4-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.4-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.4

## 升级建议

桌面客户端可以直接安装覆盖。v0.77.4 不包含破坏性配置迁移；已使用 v0.76.x 或 v0.77.x 的用户升级后，会继续沿用原有会话、模型配置和本地数据。
