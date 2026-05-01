# Lynn v0.77.3 Release Notes

> 发布日期: 2026-05-01 · 代号: "Lynn Voice Runtime"

v0.77.3 是一次语音运行时稳定性补丁：把 V0.79 Lynn Runtime 的最小可用闭环提前落到当前稳定版，修复启动白屏、语音主链、聊天记录同步、默认女声和长回复朗读中断问题。

## 重点更新

- Lynn 语音浮窗正式改名为 Lynn，不再显示 Jarvis。
- 新语音入口接入正常聊天链路：录音转写后进入当前聊天框，工具调用、记忆、历史记录和反思都沿用打字聊天路径。
- 回复语音接入 CosyVoice 默认中文女声，并修复 22.05kHz WAV 到 16kHz PCM 播放链路。
- 中文 TTS 文本规范化：日期、温度、百分比、股票代码等数字不再被中文女声读成英文 five/two。
- 长回复朗读改为小块队列：Markdown 会先清洗，长段按句号/逗号切成短块，单块失败会自动再拆小块继续播。
- 修复启动白屏/卡 splash：React selector 不再返回新数组导致 update depth 爆炸；主窗口 app-ready 丢失时会自动显示并关闭 splash。
- 修复插件独立加载：`tts-bridge` 在测试/临时插件目录里不再因为跨目录 import shared normalizer 失败。
- 打包链路加固：`build:server` 遇到 npm 镜像 tarball 损坏时自动切官方 registry 重试。

## 回归结果

- Unit/Integration：138 files / 1001 tests passed
- Voice Runtime 专项：70 tests passed
- TypeScript / syntax checks：通过
- Main / Renderer / Server build：通过
- 本地安装冷启动：通过，主窗口可进入 `index.html`

## 下载

- macOS Apple Silicon: `Lynn-0.77.3-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.3-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.3-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.3

## 升级建议

桌面客户端可以直接安装覆盖。v0.77.3 不包含破坏性配置迁移；已使用 v0.76.x 或 v0.77.x 的用户升级后，会继续沿用原有会话、模型配置和本地数据。
