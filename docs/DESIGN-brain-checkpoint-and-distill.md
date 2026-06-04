# 设计文档:brain 侧 working_checkpoint(meta 工具)+ 技能结晶 distill 触发

> 状态:**待审 + 待与 Codex 配对**。这两处都改动 brain 的 **turn 生命周期 / 模型 / 流式工具机器**(生产系统,同时服务 LIVE GUI 和 CLI 模型后端),按"最稳"原则**先设计后动手**。
> 已落地(低风险、不在本文档范围):`server/chat/skill-crystallize.ts`(纯逻辑 + store + recall,10 单测)+ `prompt-turn-runner.ts` 的**召回注入**(opt-in `BRAIN_SKILL_CRYSTALLIZE=1`,全 guard)。

---

## 0. brain 架构事实(实读所得)

| 事实 | 含义 |
|---|---|
| `prompt-turn-runner.ts` `runPromptTurn` 是流式编排:路由分类 / mutation 重水合 / stream token / 本地 Qwen 桥 / prefetch / pseudo-tool steering / internal-retry | **没有 CLI 那种 messages 数组 + 干净注入/拦截缝** |
| prompt 是字符串拼装(`effectivePromptText` 经多分支)| 注入=拼字符串(已用于召回);**meta 工具不能靠拼字符串** |
| 工具处理织进流式:`tool-use-behavior` + 流式 tool-call 解析 + `tool-turn-finalizer`(363行)+ retry/recovery | meta 工具要进这套机器,高风险 |
| `ChatTurnState` 是**单 turn 流式/解析状态**(每 turn 重建),非会话级记忆 | checkpoint 的跨 turn state 要落 engine/session 层,不能放 ChatTurnState |
| lifecycle hooks:`prompt_start` / `tool_start` / `tool_end` / `turn_end` / `turn_close`(`lifecycle-hooks.ts`)| **distill 触发可挂 `turn_end`** |
| `turn_end` 在 `hub-event-forwarder.ts:451` emit;runner 在 `routes/chat.ts:319` 创建 | hook 注册点在 chat.ts |
| 一次性模型补全:`local-qwen35-direct-runner.ts`(需确认通用补全入口)| distill 的模型调用走这里 |

---

## 1. 技能结晶 distill 触发(中风险)

**目标**:turn 成功完成后,把轨迹蒸馏成 SOP 存进 store(`skill-crystallize.ts` 的 `buildDistillPrompt`/`parseDistilledSkill`/`appendSkill` 已就绪),让已落地的**召回注入**有内容可召回。

**集成点**
- 在 `routes/chat.ts` 注册一个 `turn_end` lifecycle handler(opt-in `BRAIN_SKILL_CRYSTALLIZE=1`)。
- handler 内:成功判定 = `ss.hasOutput && !ss.hasError && !ss._lastTurnAborted`;任务文本 = `ss.originalPromptText`;最终答案 = `ss.visibleTextAcc`。
- **best-effort、fire-and-forget、全 try/catch**:distill 的模型调用失败/超时**绝不影响已完成的 turn**。

**待定(需 Codex 确认)**
1. brain 的**通用一次性补全入口**(非流式、不占用当前 session stream):用 `local-qwen35-direct-runner` 还是 engine 层?要一个"喂 prompt → 拿文本"的干净函数。
2. distill 调用的**并发/限频**:每个成功 turn +1 次模型调用,是否需要节流 / 异步队列。
3. store 落点 `~/.lynn/skills/distilled.jsonl`(`resolveBrainDataDir`)在生产是否合适;多用户/多会话是否要按 user 分目录。

**测试**:纯逻辑已覆盖(10 测);触发层加一个 hook 单测(mock 补全 + 断言 appendSkill 被调用 / 失败时 turn 不受影响)。

**灰度**:`BRAIN_SKILL_CRYSTALLIZE=1` 单实例开 → 观察模型调用量 + store 增长 + 无 turn 回归 → 再扩。

---

## 2. working_checkpoint meta 工具(高风险)

**目标**:模型可调 `update_working_checkpoint(content)`,brain 存进**会话级** state,每 turn 重新注入(扛 compaction)——CLI 已有(`isMetaTool` 拦截 + turnMessages pin)。

**难点(为什么高风险)**
- brain 的工具是**流式 tool-call 解析**出来的,经 `tool-use-behavior` + `tool-turn-finalizer` + internal-retry。要让 `update_working_checkpoint`:
  1. 出现在**模型看到的工具表**(`tool-use-behavior` / 工具定义入口,opt-in)。
  2. 在流式解析里被**识别为 meta**,**不走真实工具执行**(类比 CLI `isMetaTool`),直接写 state + 回一个合成 observation。
  3. **不触发** tool-storm / tool 预算 / finalizer 的"工具在飞"逻辑(`activeToolCallCount` 等)。
  4. 跨 turn 持久:state 落 **engine/session**(不是 `ChatTurnState`),每 turn 在召回注入同处 pin 进 `effectivePromptText`。
- 任一处理错都可能扰乱**流式 tool 编排**(影响所有走工具的 GUI/CLI turn)。

**分阶段方案(降风险)**
- **阶段 1(可先做)**:**只读 pin**——不开放模型可调工具,先在 `effectivePromptText` 注入处支持一个"会话级便签"的 pin(便签内容由别处写入,如 GUI 显式 API 或 distill 副产物)。验证 pin + 抗 compaction 路径无回归。
- **阶段 2**:开放 `update_working_checkpoint` 工具,但**先在 `tool-use-behavior` 的识别层拦截**(最早分流),证明它不进 finalizer/retry。
- **阶段 3**:接会话级持久 + resume。

**测试**:每阶段独立单测(工具识别为 meta / state 写入 / pin 注入 / 不计 tool 预算 / 不触发 finalizer)。
**灰度**:opt-in flag + 单实例 + 重点回归"带工具的 turn"全链路。

---

## 3. 配对建议

- **Codex 主**:流式 tool 识别/finalizer/retry 的内部(§2 阶段 2、§1 的补全入口)——他熟这套机器。
- **我(Claude)主**:checkpoint/结晶的**模式与纯逻辑**(已落地的 `skill-crystallize.ts` 即范式)+ 注入/拦截的契约 + 单测。
- **不触碰**:在本文档审过前,不动 `prompt-turn-runner` 的流式工具机器 / `tool-turn-finalizer` / retry。

---

## 4. 现状(本分支 `claude/native-working-checkpoint` 的 server/ 改动)
- ✅ `server/chat/skill-crystallize.ts`:纯逻辑 + store + recall(10 单测绿)。
- ✅ `prompt-turn-runner.ts`:召回注入(opt-in,全 guard,typecheck 0)。
- ⬜ distill 触发(§1)、meta 工具(§2):**待本文档审过 + 配 Codex**。
