# TTS / ASR v0.77 集成文档

> **分支**: `feat/v0.77-rag-asr`  
> **目标**: 云端默认配置 TTS 与 ASR，同时允许用户像切换 LLM Provider 一样切换语音模型。  
> **方案**: 方案 B — 前端一次性上传音频，后端同步返回 JSON，不依赖 SSE 流式。

---

## 1. 设计原则

1. **开箱即用**：默认走云端 Faster Whisper（ASR）+ Edge TTS（TTS），用户零配置。
2. **可插拔**：ASR / TTS 均抽象为 Provider Registry，新增引擎只需实现统一接口。
3. **配置隔离**：语音设置保存在 per-agent `config.yaml` 的 `voice` 区块，不同助手可独立配置。
4. **向后兼容**：所有改动均通过 `engine.config.voice` 读取，未配置时自动回退到原有默认值。

---

## 2. 文件改动清单

### 2.1 后端 · ASR Provider 抽象

| 文件 | 状态 | 说明 |
|------|------|------|
| `server/clients/asr/index.js` | 🆕 新增 | ASR Provider 注册表，统一入口 `createASRProvider(config)` |
| `server/clients/asr/faster-whisper.js` | 🆕 新增 | 自托管 Faster Whisper（原 `asr-client.js` 逻辑迁移） |
| `server/clients/asr/openai-whisper.js` | 🆕 新增 | OpenAI Whisper API（BYOK） |
| `server/clients/asr/azure-stt.js` | 🆕 新增 | Azure Speech-to-Text（占位，待补充完整 REST 适配） |
| `server/routes/audio.js` | ♻️ 重构 | `createAudioRoute(engine)`，从 `engine.config.voice.asr` 读取配置并调度 Provider |
| `server/index.js` | ♻️ 修改 | 挂载 `app.route("/api/v1/audio", createAudioRoute(engine))` |
| `server/clients/asr-client.js` | 🗑️ 删除 | 逻辑已迁移至 `server/clients/asr/faster-whisper.js` |

### 2.2 后端 · TTS Provider 抽象

| 文件 | 状态 | 说明 |
|------|------|------|
| `plugins/tts-bridge/lib/tts-registry.js` | 🆕 新增 | TTS Provider 注册表，统一入口 `createTTSProvider(config)` |
| `plugins/tts-bridge/lib/providers/edge-tts.js` | 🆕 新增 | Edge TTS（免费在线，322 音色） |
| `plugins/tts-bridge/lib/providers/macos-say.js` | 🆕 新增 | macOS `say` 命令（本地，无网络） |
| `plugins/tts-bridge/lib/providers/openai-tts.js` | 🆕 新增 | OpenAI TTS API（BYOK） |
| `plugins/tts-bridge/lib/tts-engine.js` | ♻️ 重构 | 精简为 registry 调度层 |
| `plugins/tts-bridge/tools/tts-speak.js` | ♻️ 修改 | 优先读取 `ctx.engine.config.voice.tts`，打通设置面板 |

### 2.3 前端 · 输入框集成

| 文件 | 状态 | 说明 |
|------|------|------|
| `desktop/src/react/components/voice/PressToTalkButton.tsx` | 🆕 新增 | 按住说话组件（方案 B：JSON 一次性返回，无 SSE） |
| `desktop/src/react/components/InputArea.tsx` | ♻️ 修改 | 底部工具栏插入 `PressToTalkButton`，转写结果自动填入输入框 |

### 2.4 前端 · 设置面板

| 文件 | 状态 | 说明 |
|------|------|------|
| `desktop/src/react/settings/tabs/VoiceTab.tsx` | 🆕 新增 | 语音设置 Tab：引擎选择、音色、语言、API Key |
| `desktop/src/react/settings/SettingsNav.tsx` | ♻️ 修改 | 新增 Voice Tab 导航项（麦克风图标） |
| `desktop/src/react/settings/SettingsApp.tsx` | ♻️ 修改 | 注册 `voice: VoiceTab` |

---

## 3. 架构说明

### 3.1 ASR 数据流

```
┌─────────────────┐     POST /api/v1/audio/transcribe      ┌──────────────────┐
│  PressToTalkBtn │ ── multipart/form-data (audio/webm) ──→ │  server/routes/  │
│  (InputArea)    │                                        │  audio.js        │
└─────────────────┘                                        └────────┬─────────┘
                                                                     │
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │  createASRProvider   │
                                                          │  (engine.config.     │
                                                          │   voice.asr)         │
                                                          └──────────┬───────────┘
                                                                     │
                    ┌────────────────────┬───────────────────────────┼────────────────────┐
                    │                    │                           │                    │
                    ▼                    ▼                           ▼                    ▼
         ┌─────────────────┐  ┌─────────────────┐        ┌─────────────────┐  ┌─────────────────┐
         │ faster-whisper  │  │ openai-whisper  │        │   azure-stt     │  │   (extensible)  │
         │ (默认云端)       │  │   (BYOK)        │        │   (BYOK)        │  │                 │
         └─────────────────┘  └─────────────────┘        └─────────────────┘  └─────────────────┘
```

### 3.2 TTS 数据流

```
┌─────────────────┐     POST /api/tools/tts-bridge.tts_speak     ┌──────────────────────┐
│  AssistantMsg   │ ── { text, voice, speed, filename } ────────→ │  tts-speak.js        │
│  🔊 朗读按钮     │                                               │  (读取 engine.config │
└─────────────────┘                                               │   .voice.tts)        │
                                                                  └──────────┬───────────┘
                                                                             │
                                                                             ▼
                                                                  ┌──────────────────────┐
                                                                  │  createTTSProvider   │
                                                                  └──────────┬───────────┘
                                                                             │
                              ┌────────────────────┬───────────────────────┘
                              │                    │
                              ▼                    ▼
                   ┌─────────────────┐  ┌─────────────────┐
                   │    Edge TTS     │  │  macOS say      │
                   │  (默认免费在线)  │  │  (本地降级)      │
                   └─────────────────┘  └─────────────────┘
```

### 3.3 配置持久化

设置面板通过 `autoSaveConfig({ voice: {...} })` 将配置写入当前助手的 `config.yaml`：

```yaml
voice:
  language: auto
  asr:
    provider: faster-whisper   # faster-whisper | openai | azure
    api_key: ""
    base_url: ""
  tts:
    provider: edge             # edge | say | openai
    default_voice: zh-CN-XiaoxiaoNeural
    api_key: ""
    base_url: ""
```

- **默认状态**：`provider` 留空或未设置时，ASR 回退到 `faster-whisper`，TTS 回退到 `edge`。
- **加密**：若用户填写了 `api_key`，后端复用现有的 `ProviderRegistry` AES-256-GCM 机器本地加密机制（如需，可后续接入）。

---

## 4. Provider 接口规范

### 4.1 ASR Provider

```ts
interface ASRProvider {
  name: string;
  label: string;
  transcribe(
    audioBuffer: Buffer,
    opts: { language?: string; filename?: string }
  ): Promise<{ text: string; language?: string; duration?: number }>;
  health(): Promise<boolean>;
}
```

### 4.2 TTS Provider

```ts
interface TTSProvider {
  name: string;
  label: string;
  synthesize(opts: {
    text: string;
    voice?: string;
    speed?: number;
    outPath: string;
  }): Promise<{ ok: boolean; provider: string; path: string }>;
}
```

### 4.3 新增 Provider 步骤

1. 在 `server/clients/asr/`（或 `plugins/tts-bridge/lib/providers/`）新建文件并实现接口。
2. 在对应 `index.js` 注册表中添加 `providerId → factory` 映射。
3. 在前端 `VoiceTab.tsx` 的下拉选项中追加条目。
4. 如需 API Key，在 `VoiceTab.tsx` 的 `needsXxxKey` 判断中补充条件。

---

## 5. 测试步骤

### 5.1 启动服务端

```bash
cd /Users/lynn/Downloads/Lynn
LYNN_ASR_ENABLED=true npm run server
```

### 5.2 测试 ASR 路由

```bash
curl -X POST http://localhost:18001/api/v1/audio/transcribe \
  -F "file=@/path/to/test.webm" \
  -G -d "language=zh"
```

**期望响应**：
```json
{
  "text": "你好，我是 Lynn",
  "language": "zh",
  "duration_ms": 1234
}
```

> 若未部署 Faster Whisper 服务，会返回 `500 Transcription failed`，说明路由已通，仅后端 ASR 服务未就绪。

### 5.3 测试 TTS

在桌面端聊天界面，点击任意 AI 消息右侧的 🔊 **朗读** 按钮，观察：
- 成功：提示“语音已生成”，并在 `~/.lynn/audio/` 目录生成 `.mp3` 文件。
- 失败：弹出 toast 错误提示。

### 5.4 测试语音输入

1. 打开桌面端，在聊天输入框左侧应出现 🎤 **按住说话** 按钮。
2. 按住按钮 → 开始录音，显示波形动画与计时。
3. 松开按钮 → 上传音频，显示“正在转写...”。
4. 转写完成后，文本自动填入输入框。

### 5.5 测试 Provider 切换

1. 打开 **设置 → 语音**（麦克风图标）。
2. ASR 引擎切换为 **OpenAI Whisper API**，填写 `sk-xxx` Key。
3. 点击 **保存语音设置**。
4. 重新测试按住说话，验证请求已转发至 OpenAI `/v1/audio/transcriptions`。

---

## 6. 已知限制与后续扩展

| 优先级 | 事项 | 说明 |
|--------|------|------|
| P1 | Azure STT / TTS 完整实现 | 当前为占位，需补充 Azure REST API 调用逻辑。 |
| P2 | 本地 whisper.cpp | 不依赖云端 GPU 的降级方案，Apple Silicon 可跑 tiny/base。 |
| P3 | Web Speech API | 浏览器原生 `webkitSpeechRecognition`，完全零安装。 |
| P4 | 音色可视化选择 | Edge TTS 322 个音色做成可搜索下拉列表。 |
| P5 | 语音消息内嵌播放器 | 生成的 `.mp3` 在聊天消息里直接播放，而非仅保存到文件。 |
| P6 | `directSendToChat` | PressToTalkButton 的“语音直接进 Chat”模式，当前抛错未实现。 |

---

## 7. 安全与兼容

- **零生产用户感知**：若未设置 `LYNN_ASR_ENABLED=true`，服务端路由仍然可用，但 ASR 服务不可用时返回 500，前端有错误提示兜底。
- **配置隔离**：`voice` 区块独立存在于 per-agent `config.yaml`，不影响现有 `api` / `models` 等配置。
- **Key 安全**：API Key 目前以明文形式保存在 `config.yaml` 中，如需加密，可复用 `core/provider-registry.js` 的 `_encryptKey` / `_decryptKey` 机制。
- **旧客户端兼容**：`AssistantMessage.tsx` 的朗读按钮和 `tts-bridge.tts_speak` 接口保持不变，旧版本前端仍可正常调用 TTS。
