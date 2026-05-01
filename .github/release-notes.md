# Lynn v0.77.5 Release Notes

> 发布日期: 2026-05-02 · 代号: "Stoppable Speech & Bridge Stability"

v0.77.5 是一次面向用户体感的稳定性补丁:**长朗读现在可以随时中断**,**微信/飞书桥接的天气查询不再触发"本轮没生成可见答案"兜底**,语音首字延迟和"只播头一段"竞态也一并修掉。

## 重点更新

### 朗读与语音
- 🛑 **朗读按钮 toggle 化**:聊天页"朗读"按钮支持二次按下立即停止,长回复播报中再按一次直接断音;切换消息或关闭窗口也会自动停。
- ⚡ **语音首字延迟优化**:Brain `text_delta` → TTS 首段播放路径精简,首字到嘴时间下降。
- 🧯 **B2 race 双缓冲修复**:修复"完整文字到了但语音只播了头一段"竞态(server speakText 循环 queue 空 grace 期 + pendingAppendQueue 缓冲),覆盖 client SPEAK_TEXT_APPEND 在 server 刚消费完 active queue 的 race window。

### 桥接稳定性
- 🤖 **微信/飞书天气查询不再"空答"**:长对话历史下,A3B 输出被伪工具检测器误剥成空内容触发"本轮模型没有生成可见答案"兜底文案的问题;`BRIDGE-OVERSANITIZE-FALLBACK v1` 在 sanitize 剥空时回退到原 `capturedText`(≥50 字),保证用户至少看到回复。

### 代码改动汇总
- `desktop/src/react/components/chat/AssistantMessage.tsx`:`playAudioHttpUrl` 重构返回 `{stop, finished}` controller(WebAudio + HTMLAudio 双路径都支持 stop)+ `ttsPlaying` state + `useEffect` cleanup 防 unmount 后音频泄漏。
- `core/bridge-session-manager.js`:`BRIDGE-OVERSANITIZE-FALLBACK v1` — sanitize 剥空但 raw capturedText 有内容时返回 raw,避免触发 empty-turn 兜底文案。
- `server/routes/voice-ws.js`:`speakText` 循环重构,加 `pendingAppendQueue` + 150ms grace 期(`LYNN_VOICE_APPEND_GRACE_MS` 可调),`appendSpeakText` 状态机细化(SPEAKING + active truthy / processingTurn alive / IDLE 三档处理)。

## 回归结果

- Unit / Integration / Voice runtime / TypeScript / Lint / Renderer build / Main build / Server build:全过
- 1127+ vitest 通过
- 本地 DMG 冷启动:已通过

## 下载

- macOS Apple Silicon: `Lynn-0.77.5-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.5-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.5-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.5

## 升级建议

桌面客户端可以直接安装覆盖。v0.77.5 不包含破坏性配置迁移;已使用 v0.76.x / v0.77.x 的用户升级后,会继续沿用原有会话、模型配置和本地数据。
