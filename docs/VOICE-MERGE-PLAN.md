# Lynn Voice Merge Plan

> 更新时间：2026-04-23
> 目标：把 v0.77 里的语音相关能力拆成可稳定落地的主线迭代，而不是把 TTS / ASR / RAG / 图片半成品一次性并入 `main`。

## 一句话结论

- `TTS`：现在已经接近可独立合入 `main`
- `ASR`：还不能直接进 `main`，需要补主 App 接入、HTTP 路由、部署说明和失败降级
- `Voice Mode`（能听也能说）：必须在 `TTS` 和 `ASR` 各自稳定后再做
- `RAG / Flux`：不要和语音一起绑定进入主线

---

## 1. 当前真实状态

### 1.1 TTS

当前链路已经基本打通：

- 引擎：[/Users/lynn/Downloads/Lynn/plugins/tts-bridge/lib/tts-engine.js](/Users/lynn/Downloads/Lynn/plugins/tts-bridge/lib/tts-engine.js)
- 工具：[/Users/lynn/Downloads/Lynn/plugins/tts-bridge/tools/tts-speak.js](/Users/lynn/Downloads/Lynn/plugins/tts-bridge/tools/tts-speak.js)
- 前端按钮：[/Users/lynn/Downloads/Lynn/desktop/src/react/components/chat/AssistantMessage.tsx](/Users/lynn/Downloads/Lynn/desktop/src/react/components/chat/AssistantMessage.tsx)
- 工具路由：[/Users/lynn/Downloads/Lynn/server/routes/tools.js](/Users/lynn/Downloads/Lynn/server/routes/tools.js)

已经完成的收口：

- manifest 只保留实际实现的 provider
- 前端改为调用完整工具名
- 后端支持精确匹配 + 唯一后缀别名匹配
- 已补 alias 回归测试

结论：`TTS` 属于“最后一公里”问题，适合先入主线。

### 1.2 ASR

当前只具备骨架，不具备主线交付条件：

- 组件：[/Users/lynn/Downloads/Lynn/desktop/src/components/voice/PressToTalkButton.tsx](/Users/lynn/Downloads/Lynn/desktop/src/components/voice/PressToTalkButton.tsx)
- 客户端：[/Users/lynn/Downloads/Lynn/server/clients/asr-client.js](/Users/lynn/Downloads/Lynn/server/clients/asr-client.js)

缺失项：

- 没有服务端 `audio` HTTP 路由
- 主 React App 未接入麦克风按钮
- 当前组件默认依赖 `/api/v1/audio/*`，但服务端并未挂载
- faster-whisper 服务不在项目内，需要外部部署

结论：`ASR` 现在是“从零到一”问题，不适合直接并入 `main`。

### 1.3 现有文档状态

[/Users/lynn/Downloads/Lynn/docs/RELEASE-NOTES-v0.77.md](/Users/lynn/Downloads/Lynn/docs/RELEASE-NOTES-v0.77.md) 当前明显超前描述了：

- 主输入框旁按住说话
- 5 秒录音 1 秒转文字
- 音视频拖入自动转写
- 会议录音自动总结

这些都还没有达到真实可交付状态。

结论：任何主线合入前，都要先修正文案，或者不要让这份 release notes 直接代表当前代码状态。

---

## 2. 合入原则

1. 不把“能说”和“能听”绑成一个 PR
2. 不把语音和 `RAG / Flux` 绑成一个 PR
3. 先合低风险、用户价值明确的链路
4. 每一步都要能独立回滚
5. 不复制组件；优先复用或抽公共逻辑

---

## 3. Phase 1：TTS Experimental 进入 Main

### 3.1 目标

用户可以在 Lynn 回复旁点击朗读按钮，生成语音并播放/打开音频结果。

### 3.2 应进入主线的文件

- [/Users/lynn/Downloads/Lynn/plugins/tts-bridge/manifest.json](/Users/lynn/Downloads/Lynn/plugins/tts-bridge/manifest.json)
- [/Users/lynn/Downloads/Lynn/plugins/tts-bridge/lib/tts-engine.js](/Users/lynn/Downloads/Lynn/plugins/tts-bridge/lib/tts-engine.js)
- [/Users/lynn/Downloads/Lynn/plugins/tts-bridge/tools/tts-speak.js](/Users/lynn/Downloads/Lynn/plugins/tts-bridge/tools/tts-speak.js)
- [/Users/lynn/Downloads/Lynn/server/routes/tools.js](/Users/lynn/Downloads/Lynn/server/routes/tools.js)
- [/Users/lynn/Downloads/Lynn/desktop/src/react/components/chat/AssistantMessage.tsx](/Users/lynn/Downloads/Lynn/desktop/src/react/components/chat/AssistantMessage.tsx)
- [/Users/lynn/Downloads/Lynn/tests/plugin-desk-integration.test.js](/Users/lynn/Downloads/Lynn/tests/plugin-desk-integration.test.js)
- [/Users/lynn/Downloads/Lynn/tests/tools-route.test.js](/Users/lynn/Downloads/Lynn/tests/tools-route.test.js)

### 3.3 明确不进入主线的内容

- ASR 组件
- ASR client
- Memory badge
- RAG 相关插件
- Flux 相关插件
- v0.77 的整包 release notes 宣传口径

### 3.4 验收标准

1. 点击朗读按钮可成功调用 `tts-bridge.tts_speak`
2. `/api/tools/tts_speak` 与 `/api/tools/tts-bridge.tts_speak` 都可工作
3. 工具名冲突时不会误路由，而是返回歧义错误
4. manifest 不再承诺未实现 provider
5. 所有 TTS 相关测试通过

### 3.5 建议分支策略

不要直接从 `feat/v0.77-rag-asr` 往 `main` 粗合并再删文件。

建议：

- 新开一个干净分支，例如 `feat/tts-experimental`
- 只选择 TTS 相关文件提交
- 单独提 PR

---

## 4. Phase 2：ASR Experimental（仅语音输入）

### 4.1 目标

用户按住说话，松开后把转写结果放进输入框，由用户自己编辑和发送。

### 4.2 刻意不做

- 不做语音直发聊天
- 不做 `audio/chat`
- 不做会议录音自动总结
- 不做 partial SSE 实时转写
- 不做自动语音回复

### 4.3 必须新增或修改的文件

#### Server

- 新增 [/Users/lynn/Downloads/Lynn/server/routes/audio.js](/Users/lynn/Downloads/Lynn/server/routes/audio.js)
- 修改 [/Users/lynn/Downloads/Lynn/server/index.js](/Users/lynn/Downloads/Lynn/server/index.js)
- 修改 [/Users/lynn/Downloads/Lynn/server/clients/asr-client.js](/Users/lynn/Downloads/Lynn/server/clients/asr-client.js)

#### Client

- 复用 [/Users/lynn/Downloads/Lynn/desktop/src/components/voice/PressToTalkButton.tsx](/Users/lynn/Downloads/Lynn/desktop/src/components/voice/PressToTalkButton.tsx)
- 修改 [/Users/lynn/Downloads/Lynn/desktop/src/react/components/InputArea.tsx](/Users/lynn/Downloads/Lynn/desktop/src/react/components/InputArea.tsx)
- 视需要补输入区样式文件

#### Docs

- 新增 [/Users/lynn/Downloads/Lynn/docs/ASR-SETUP.md](/Users/lynn/Downloads/Lynn/docs/ASR-SETUP.md)

### 4.4 重要实现约束

1. 不复制 `PressToTalkButton`
   - 直接接入主 App，或抽公共逻辑
   - 不要维护两份实现

2. 路由前缀先统一
   - 当前组件默认使用 `/api/v1/audio/*`
   - 建议服务端也明确挂到 `/api/v1/audio`
   - 不要一边 mock 用 `/api/v1`，一边正式接口挂 `/api`

3. Phase 2 先走 final-only
   - 路由直接返回 JSON
   - 前端不消费 SSE partial
   - 等 Phase 3 再扩 streaming

4. 必须有失败降级
   - 未配置 `LYNN_ASR_URL`
   - ASR health check 失败
   - 麦克风权限被拒绝
   - 上传超时或服务端报错

### 4.5 验收标准

1. 用户按住说话后，文字能稳定进入输入框
2. ASR 服务不可用时，UI 有清晰提示
3. 不影响现有输入框和发送流程
4. 不开启任何“自动发送”能力

---

## 5. Phase 3：Voice Mode（能听也能说）

### 5.1 目标

实现完整链路：

`用户说话 -> ASR 转文字 -> Lynn 回复 -> TTS 播报`

### 5.2 启动条件

只有满足下面条件，才建议开启：

1. `TTS` 已在主线稳定至少 1 个版本周期
2. `ASR` 输入链路已在主线稳定至少 1 个版本周期
3. 麦克风权限、上传失败、TTS 播放失败都已有明确降级

### 5.3 可在这一阶段加入的能力

- 语音直发聊天
- 自动语音回复
- 消息内嵌音频播放器
- 中断播放 / 重播
- partial ASR
- 连续语音模式

### 5.4 这一阶段的风险

- 前端状态机显著复杂化
- 音频资源管理更容易出内存泄漏
- 用户容易在公共场景被自动播报打扰

建议默认关闭自动语音回复。

---

## 6. 不应与语音主线绑定进入 Main 的内容

以下内容应继续作为单独工作线推进：

- [/Users/lynn/Downloads/Lynn/plugins/rag-core](/Users/lynn/Downloads/Lynn/plugins/rag-core)
- [/Users/lynn/Downloads/Lynn/plugins/flux-studio](/Users/lynn/Downloads/Lynn/plugins/flux-studio)
- 记忆 badge / 自动知识注入 / 图片生成 provider 扩展

原因：

- 它们与 `TTS` 没有强耦合
- 绑在一起只会扩大回归面
- 当前仍处于 experimental 或未完全兑现文案阶段

---

## 7. 对现有 v0.77 文档的处理建议

### 7.1 需要立即修正的文案

[/Users/lynn/Downloads/Lynn/docs/RELEASE-NOTES-v0.77.md](/Users/lynn/Downloads/Lynn/docs/RELEASE-NOTES-v0.77.md) 建议至少调整为：

- `TTS`：可作为“实验能力”保留
- `ASR`：改成“开发中 / 即将接入主输入框”
- 删除或降级会议录音、音视频拖拽自动转写等承诺

### 7.2 可保留但需加条件的表述

- faster-whisper 作为外部服务依赖
- 后续目标是语音输入 + 语音回复闭环

---

## 8. 推荐执行顺序

1. 先修正文案
2. 提取 `feat/tts-experimental`
3. 合入 `TTS experimental`
4. 新开 `feat/asr-input-experimental`
5. 合入 `ASR input experimental`
6. 稳定一个版本周期后，再规划 `Voice Mode`

---

## 9. 当前决策

### 可以现在做的

- 合入 `TTS experimental`
- 继续整理 `ASR` 接入计划

### 不应现在做的

- 把 `ASR + TTS + RAG + Flux` 一次性并入 `main`
- 按当前 release notes 宣传 `ASR 已可用`
- 复制 `PressToTalkButton` 另起一套实现

---

## 10. 备注

这份文档的目标不是描述“最终愿景”，而是明确：

- 现在什么能进主线
- 什么还不能进
- 下一步具体该改哪些文件
- 哪些超前承诺必须先降下来

如果未来 `ASR` 真正接上了主输入框并跑通服务端，再单独追加一份 `ASR Integration Checklist` 会更稳。
