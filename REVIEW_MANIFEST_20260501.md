# V0.79 Phase 2 本轮冲刺 — Review Manifest

**时间窗**:2026-05-01 11:00 - 12:47(~1h45min 实操)
**git 基线**:`2937d19` (v0.77.3 voice runtime)
**本轮状态**:未 commit(你审阅通过后我/你可选 commit)

---

## 📦 新建文件(12 个,全部从头看即可)

| 文件 | 行数 | 一句话作用 |
|------|------|-----------|
| **server/chat/voice-fallback-orchestrator.js** | 108 | DS 反馈 #5 · Phase 2.5 降级纯函数 `computeVoiceTier` + `enrichHealthWithTier` |
| **server/chat/voice-self-interrupt-tracker.ts** | 140 | DS 反馈 #3 · A/B/user 分类 + `assertWithinBudget` 三档验收 |
| **desktop/src/react/services/silero-vad-browser.ts** | 99 | Silero VAD stub + 4 个真实雷区注释 + 激活清单 |
| **dgx-services/asr_server.py** | 240 | Qwen3-ASR FastAPI(language 归一化 + lifespan 预热 + 60s 上限) |
| **dgx-services/emotion_server.py** | 175 | emotion2vec+ FastAPI(9 类 top1 + warmup) |
| **dgx-services/systemd/lynn-qwen3-asr.service** | 34 | ASR systemd unit(`HF_HUB_DISABLE_XET=1` + `TimeoutStartSec=900`) |
| **dgx-services/systemd/lynn-emotion2vec.service** | 28 | emotion systemd unit |
| **dgx-services/README.md** | 150 | DGX 一键部署步骤 + 契约 + 监控 |
| **tests/voice-ws-interrupt-state-machine.test.js** | 280 | 12 cases:emotion 4s 切段 + isSemanticTranscript + T1/T2 集成 |
| **tests/voice-fallback-orchestrator.test.js** | 125 | 15 cases:Tier 1-6 全覆盖 + enrich 向后兼容 |
| **tests/voice-self-interrupt-rate.test.ts** | 155 | 14 cases:A/B/user 判定 + DS 三档 budget + 30min skip gate |
| **spike/05-erle-test/erle-self-record.mjs** | 25 | 弃用提示(历史脚本,指向 LYNN_ERLE_RECORD_DIR 新路径) |

**小计**:~1560 新行,全部是我本轮从零写的,审阅安全(不和其他 session 混)

---

## ✏️ 修改现有文件(6 个,需点位审阅)

### 1. `server/routes/voice-ws.js` — 核心大件
本轮**真实改动锚点**(grep 本文件找以下字符串即是我的代码):

| 关键字 | 位置/语义 |
|--------|----------|
| `enrichHealthWithTier` | import 新加 + `checkHealth` 里调 |
| `extractEmotionSegment` | 新 export 函数 + `processTurn` 里 `serProvider.classify(extractEmotionSegment(wavAudio), ...)` |
| `isSemanticTranscript` | 新 export 函数 |
| `saveInterruptedTurn` | constructor 新参数 + `resolveInterruptedReply` 内部调 |
| `pendingInterruptedReply` | constructor 新字段 + `onInterrupt` T1 快照 + `resolveInterruptedReply` T2 清理 |
| `currentReplyPlayed` | constructor 新字段 + `speakText` 维护进度 + `onInterrupt` 快照 |
| `resolveInterruptedReply` | 新 method |
| `DS V4 Pro` | 所有我加的注释锚 |
| `erleRecord` | constructor 新字段 + `onAudio` mic 累积 + `speakText` tts 累积 + `onClose` 落盘 |
| `LYNN_ERLE_RECORD_DIR` | 环境变量入口 |
| `方案 C 微交互` | `processTurn` 进 THINKING 立即 send `TRANSCRIPT_PARTIAL = "理解中…"` 那段 |

**建议审阅法**:
```bash
grep -n "DS V4 Pro\|方案 C\|extractEmotionSegment\|isSemanticTranscript\|pendingInterruptedReply\|currentReplyPlayed\|erleRecord\|enrichHealthWithTier\|理解中" server/routes/voice-ws.js
```

> ⚠️ 文件里还有 `stripEmojiForTts` / `normalizeVoiceTranscript` 等**不是我加的**(其他 session 在同时段修的),不在本审阅范围。

### 2. `server/clients/asr/qwen3-asr.js` — 2 行注释
只加了一行中文注释说明"server 端已做 language 归一化"。

### 3. `desktop/src/react/services/voice-ws-client.ts` — 4 行
`VoiceHealthStatus` 接口新加 3 个可选字段:`tier` / `orbColor` / `tierLabel`。
**审阅锚**:grep `DS V4 Pro 反馈 #5`

### 4. `desktop/src/react/components/voice/JarvisRuntimeOverlay.tsx` — 2 处
- `formatHealth` 优先用 `tierLabel`(向后兼容)
- `<div className={styles.orb}>` 新增 `data-orb-color` + `data-tier`
**审阅锚**:grep `DS V4 Pro 反馈 #5` / `2026-05-01`

### 5. `desktop/src/react/components/voice/JarvisRuntimeOverlay.module.css` — 18 行新增
CSS 末尾追加 `.orb[data-orb-color="yellow"]` / `.orb[data-orb-color="red"]` + `@keyframes orb-alert`
**审阅锚**:grep `DS V4 Pro 反馈 #5`

### 6. `spike/05-erle-test/README.md` — 整篇重写
旧方案(sox + BlackHole)被彻底推翻,换成 voice-ws 内置 `LYNN_ERLE_RECORD_DIR` 路径。

---

## 🗂️ 记忆 / 规划文档(Lynn repo 之外,在 `~/.claude/projects/...`)

| 文件 | 作用 |
|------|------|
| `memory/project_roadmap_0501.md` | 七日冲刺 + DS 反馈嫁接盘点 + 铁律 #13 mem-fraction 0.70 |
| `memory/feedback_v079_phase2_truths.md` | 5 个真实雷区 + 方案 C 决策 + 实测数据(**最重要**) |
| `memory/reference_dgx_stability_bugs.md` | 铁律段 0.80 → 0.70 同步(line 28-33) |
| `memory/MEMORY.md` | PRE-FLIGHT 第 13 条 + 索引新增两条 |

---

## 🧪 测试全量

```
tsc --noEmit          : 0 errors
vitest run            : 1053 passed + 1 skipped / 142 test files
                        (v0.77.3 基线 1001 → 1053,+52 new all green)
lint                  : 0 errors / 62 warnings (pre-existing 61 + 1 他人改动)
```

本轮新增 41 tests:
- `voice-ws-interrupt-state-machine.test.js` 12 ✓
- `voice-fallback-orchestrator.test.js` 15 ✓
- `voice-self-interrupt-rate.test.ts` 13 + 1 skip ✓

---

## 🚀 DGX 实测(不是理论,是 systemd 和 curl 跑出来的)

```
lynn-emotion2vec.service   active ✓
  VRAM:      370 MB  (原估 1-2GB 过高)
  latency:   95 ms   (P50 估 70ms → 含 HTTP/form 后实测 95)
  top1:      生气/angry 1.0 (9 类合法)

lynn-qwen3-asr.service     active ✓
  VRAM:      1507 MB (与 MEMORY 记录完全对齐)
  latency:   112-145 ms(三路 zh/Chinese/auto 都过)
  真实雷区 #1: language 只吃完整英文名(zh → Unsupported Language: Zh 报错)
             已在 server 端 _normalize_language() 归一化

本机 ~/.ssh/config 隧道:  127.0.0.1:18007/18008 通 ✓
server/.env 环境变量已写入 ✓
```

---

## ⚠️ 审阅时你要警惕的点(我的透明度)

1. **雷区 #2 streaming only vLLM** — MEMORY 旧写的 `init_streaming_state` 是我踩坑的推测,这轮实证推翻了。方案 C 应对这个现实。
2. **Silero VAD 是 stub 不是真跑** — 未 `npm install`(避免破 lockfile),需你授权后一行代码切真。
3. **30min 自打断率是 tracker + 单测,不是真 30min 长测** — 真实长测 runner 待建。
4. **ERLE 方案从 sox → voice-ws 内置双轨** — 我改得更简洁了,但你真实跑前没验证过,你跑一次 `LYNN_ERLE_RECORD_DIR=/tmp/lynn-erle npm run dev` 才能确认录出来的 wav 真的能拿去 erle-bench。
5. **git status 混了其他 session 改动** — `core/llm-utils.js` / `desktop/src/react/components/chat/*` / `server/chat/{tool-use-behavior,translation-intent,internal-retry,turn-state,stream-state}.js` / `tests/internal-retry.test.js` 等**不在本轮范围**,审阅时略过。

---

## 🔍 推荐审阅流程(20 分钟量级)

**第 1 步(5 min)**:读 `memory/feedback_v079_phase2_truths.md` 了解背景/决策

**第 2 步(5 min)**:打开 3 个纯新文件,从头看
- `server/chat/voice-fallback-orchestrator.js` 108 行,纯函数
- `server/chat/voice-self-interrupt-tracker.ts` 140 行,纯数据流
- `desktop/src/react/services/silero-vad-browser.ts` 99 行,stub 读注释

**第 3 步(5 min)**:跑一次本轮新加的 3 个测试文件,自己眼过测试 case 看是否合理
```bash
npx vitest run tests/voice-ws-interrupt-state-machine.test.js \
                tests/voice-fallback-orchestrator.test.js \
                tests/voice-self-interrupt-rate.test.ts --reporter=verbose
```

**第 4 步(5 min)**:`voice-ws.js` 按锚 grep,只看我新加的那 ~200 行
```bash
grep -n "DS V4 Pro\|方案 C\|erleRecord\|理解中\|resolveInterruptedReply" \
       server/routes/voice-ws.js
```

**第 5 步(可选)**:DGX 侧真跑
```bash
ssh dgx 'curl -s localhost:18007/health; curl -s localhost:18008/health'
# 预期:{ok:true...} 两份
```

---

## 💾 建议 commit 策略

如果审阅通过,建议**按块拆 3-4 个 commit**(MEMORY 铁律 #8 worktree sync 风险):

```
commit 1: feat(v0.79/dgx): ASR + emotion FastAPI + systemd units
  - dgx-services/{asr_server.py, emotion_server.py, systemd/*, README.md}

commit 2: feat(v0.79/voice): DS V4 Pro 反馈 #2 #3 落地 — emotion 4s + T1/T2 interrupted
  - server/routes/voice-ws.js (extractEmotionSegment + isSemanticTranscript + 状态机)
  - server/clients/asr/qwen3-asr.js (language 归一化注释)
  - tests/voice-ws-interrupt-state-machine.test.js

commit 3: feat(v0.79/voice): DS 反馈 #4 #5 落地 — Phase 2.5 降级 orchestrator + tier Orb
  - server/chat/voice-fallback-orchestrator.js
  - server/chat/voice-self-interrupt-tracker.ts
  - desktop/src/react/services/voice-ws-client.ts (VoiceHealthStatus 字段)
  - desktop/src/react/components/voice/JarvisRuntimeOverlay.{tsx,module.css}
  - tests/voice-fallback-orchestrator.test.js
  - tests/voice-self-interrupt-rate.test.ts

commit 4: feat(v0.79/voice): 方案 C 心理补偿 + ERLE 双轨 + Silero VAD stub
  - server/routes/voice-ws.js (erleRecord / "理解中…" partial)
  - desktop/src/react/services/silero-vad-browser.ts
  - spike/05-erle-test/{README.md, erle-self-record.mjs}
```

不 commit 也行,等你整体过完再定。

---

## 🎯 给你的一段话结论

**本轮时间支出 1h45min,产出**:
- DGX 双服务端到端真实跑通(不是骨架,是 systemd active + curl 200)
- DS V4 Pro 5 条反馈全部落代码(41 新测试全绿)
- 雷区 #1 #2 实证推翻 MEMORY 旧推测并修
- Orb 6 档 + 心理补偿 + ERLE 优雅方案
- 1053 tests pass / 0 回归 / 0 lint error

**未做明确标注**:Silero VAD 真 npm install、30min 长测 runner、ERLE 真录、方案 A vLLM 迁移。

**可审阅入口**:你可直接打开 12 个新文件 + `voice-ws.js` 按锚 grep + 跑 3 个新测试文件,20 分钟可过完。
