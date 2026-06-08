[English](README_EN.md) | **中文**

<p align="center">
  <img src="desktop/src/assets/Lynn.png" width="80" alt="Lynn">
</p>

<h1 align="center">Lynn</h1>

<p align="center"><strong>GUI 指挥台 · CLI Worker Fleet · 长期记忆 · 多 Agent 协作</strong></p>
<p align="center">开源桌面 AI Agent:用 GUI 指挥台并行调度多个代码 CLI(Codex / Claude / Qwen…),编程 / 研究 / 业务同台可视化编排——不是又一个聊天框,而是多 CLI 编排台</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://github.com/MerkyorLynn/Lynn/releases"><img src="https://img.shields.io/badge/App-0.81.0-brightgreen" alt="App Version"></a>
  <a href="https://github.com/MerkyorLynn/Lynn/releases"><img src="https://img.shields.io/badge/CLI-0.81.0-7bcad3" alt="CLI Version"></a>
  <a href="https://github.com/MerkyorLynn/Lynn/stargazers"><img src="https://img.shields.io/github/stars/MerkyorLynn/Lynn?style=social" alt="Stars"></a>
  <a href="https://github.com/MerkyorLynn/Lynn/releases"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg" alt="Platform"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript" alt="TypeScript"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-38-47848f?logo=electron" alt="Electron"></a>
</p>

---

## 🧠 第一部分 · 引擎与模型

### ① 专属任务编排器蒸馏模型（Lynn Agent 的大脑）

Lynn Agent 的核心是一个会**快速 拆分 → 分派 → 验收**任务的编排器。我们为此**专门蒸馏**了一个模型:用 LoRA（**r=64 / α=128 / dropout 0.05**,**1842 条蒸馏样本**)把 **DeepSeek-V4-Pro 在「思考开启(thinking-on)」时的多步推理与自我验证思维方式**蒸进 **Qwen3.6-35B-A3B**(MoE,3B 激活)。

编排器有三个硬条件——**快、会拆解验收、不乱报完成**。实测(同一 harness,thinking-on):

| 维度 | 蒸馏编排器 | 原版 A3B | 说明 |
|---|---|---|---|
| 端到端编排耗时 | **26.6s** | 60.7s | 决断不啰嗦,比原版快 2.3×、比云 API 快 2–3× |
| GPQA-Diamond-198 | **80.3%**(32K) | 72.7% | 硬推理 **+7.6pp** |
| MMLU-500 | 90.2% | 91.4% | 知识广度持平 |
| 编排假验证(20×5) | **0 / 20** | 0 / 20 | 自报完成与真实状态一致 |

关键:蒸馏与原版**单流 TPS 相同**(R6000 ~224 tok/s),但端到端编排**快一倍**——**蒸的是「思维方式」,红利是更少 token 到结论**。难题(如并发)仍由 **harness 客观验证 + DS-Pro 逃生舱**兜底(实测证明硬题上模型自报不可信)。

📦 **ModelScope**:`Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill` · **HuggingFace**:`nerkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill`(BF16 + Q4_K_M gguf)
> 与早期 `Lynn-V4-Pro-Distill` 区分:这一版蒸的是 **thinking-on 的思维方式**,目标「学会怎么想」,直接服务 Agent 编排。

### ② 引擎路线:端侧选最快的 llama.cpp,并回馈上游

我们自研过 NVFP4 推理引擎,在 Blackwell 上认真啃了几周内核。结论很硬:**单流 decode 是带宽 / launch 游戏,自写内核打不过成熟的 llama.cpp**。

| 单流 decode(同模型同卡) | tok/s |
|---|---|
| llama.cpp Q4_K_M(Spark sm_121) | **69.77**(+MTP **79**) |
| 自研 NVFP4(Spark,内核融合后) | ~45 |
| llama.cpp Q4_K_M(R6000) | ~207 |
| 自研 NVFP4(R6000 strict) | ~108 |

所以**端侧主推理我们选 llama.cpp**(单流最快、生态成熟、全平台),并把实测验证的改进**回馈上游**:
- [#24273](https://github.com/ggml-org/llama.cpp/pull/24273) NVFP4 转换 / 后端 / 基准实测指南文档(open,review 中)

不是放弃,是「打得过就用、用得上就贡献」——**自研引擎收束为研究资产,前沿 NVFP4 仍在持续科研**。

### ③ 不放弃 NVFP4:前沿在并发服务侧,已用 vLLM 求证

NVFP4 的真正红利不在单流 decode,而在**并发吞吐**。同一张 R6000,`VLLM_MOE_FORCE_MARLIN=1`:

| 并发 | 1 | 16 | 64(release soak) |
|---|---|---|---|
| 输出 tok/s | 175 | 1289 | **2434**(0 failed) |

**NVFP4 vs FP8(同机同 harness):每档都赢 1.14–1.34×**。我们把这条 W4A16 NVFP4 Marlin 路径的**回归测试 / 文档 / 正确性门禁回馈给 vLLM**(3 个 open PR,maintainer review 中):
- [#44671](https://github.com/vllm-project/vllm/pull/44671) Add ModelOpt W4A16 lm_head regression tests
- [#44672](https://github.com/vllm-project/vllm/pull/44672) Document ModelOpt W4A16 NVFP4 Marlin path
- [#44673](https://github.com/vllm-project/vllm/pull/44673) Add speculative decoding correctness gate

---

## 🔭 V0.80:GUI + CLI Worker Fleet

V0.80 把 Lynn 带回编程主战场,但不是再做一个单 CLI 或 IDE 插件。Lynn 的方向是把 **GUI 变成多个 CLI Agent 的指挥台**:你可以在图形界面里拆任务、派发给不同 CLI worker、查看日志和 diff、跑门禁、合并或丢弃结果。

这不是“不服务代码”。恰恰相反,Lynn 要把代码任务和业务任务放到同一个调度系统里:

- **GUI 指挥台**:在 Lynn 桌面端创建任务、分配 worker、查看每条 worker 的 stdout/stderr、diff、测试结果和越界修改。
- **CLI Worker Fleet**:统一调度 Codex、Claude Code、Qwen、codebuddy、Kimi、opencode 或自定义 CLI,每个 worker 自动进入独立 worktree。
- **任务协议化**:自动生成 task brief,包含 owned files、forbidden files、验收标准、测试命令和提交要求。
- **Merge Queue**:worker 完成后进入人工验收队列,可以 cherry-pick、merge、abandon,并在合并后自动跑 release gate。
- **`@lynn/cli`**:V0.80 同步发布 npm CLI 包,支持 `Lynn -p`、`Lynn code`、`Lynn agents` 和 `Lynn worker run`,既能给终端用户使用,也能被 GUI 调度。

Cursor 解决“我正在编辑这段代码”;Claude Code / Codex CLI 解决“我在终端里让一个 Agent 干活”。Lynn V0.80 要解决的是下一层问题:**当你同时有 3-5 个 CLI Agent、多个 worktree、代码任务和业务任务并行时,谁来调度、验收和收口。**

### CLI 快速安装

V0.80 的 CLI 是 Lynn 的终端版:跑在命令行里的 AI 编码助手,带终端 TUI、完整 Markdown 渲染、流式输出、工具调用和长任务续跑。它可以独立给人使用,也可以给其他智能体和 CI 当无交互 worker。**一行命令装好,不用克隆仓库、不用编译。**

```bash
# 1. Node requirement: Node.js 20 LTS or 22 LTS with npm.
# Check: node -v should be >= v20.
# macOS: brew install node@20
# macOS/Linux: nvm install 20 && nvm use 20
# Windows: winget install OpenJS.NodeJS.LTS

# 2. Install or update from the Lynn mirror. --force is safe for first install too.
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"

# 3. Launch.
Lynn            # interactive chat TUI
Lynn code       # coding-agent TUI
Lynn --version  # should print 0.81.0
Lynn agents     # copyable headless/Fleet commands for other agents
```

默认走 Brain V2 路由:本地 Lynn Brain 可用时优先本地,不可用时自动回到 Lynn 远端 Brain。模型级联为 **StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算) → Spark Qwen 3.6 35B A3B**。纯 CLI 用户也可以用 `Lynn providers set ...` 绑定自己的 OpenAI 兼容端点。

长任务默认采用 Reasonix 风格的**前置缓存纪律**:稳定前缀、工具定义、运行时约束和 resume 摘要分层固定,避免每轮重排导致 prefix drift;缓存命中以 `prefix-cache ... hit` 进入 usage、session、replay 和 `Lynn cache doctor --json`,不在界面里制造上下文焦虑。

面向其他智能体的最短静默契约:

```bash
Lynn code -p "fix tests, run the suite, summarize the diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session
```

需要“穷尽最优解”时用 `--best`(或 `/goal` / `/best` 交互入口):Lynn 会启用 300 步预算、ultra 任务分解、原子 worker、对抗式验收、自动验证、checkpoint/resume 和运行时压缩。它不会用路由替模型选答案,只负责拆步、调度、验证和防工具风暴。

机器调用请只解析 JSONL,不要解析人类 TUI。完整契约见 [`docs/ops/lynn-code-headless-agent-contract.zh.md`](docs/ops/lynn-code-headless-agent-contract.zh.md) / [`English contract`](docs/ops/lynn-code-headless-agent-contract.md)。

### Agent Quick Contract

`Lynn` 也可以作为给 Codex / Claude Code / Qwen / Kimi 调用的 worker-runner。交互式 TUI 给人看;机器调用请用 `-p --json` 或 `worker run --jsonl`。

```bash
# 单次无交互任务,打印 JSON/JSONL 后退出。
Lynn -p "总结这个 repo" --json
git diff | Lynn code -p "审查这个 diff,只输出风险和测试建议" --json

# Fleet worker:GUI Fleet 与各家 coding CLI 的统一适配器。
Lynn worker run --brief task.md --worktree . --jsonl
Lynn worker run --brief task.md --worktree . --agent codex-cli --jsonl
Lynn worker run --brief task.md --worktree . --agent claude-code --jsonl
Lynn worker run --brief task.md --worktree . --agent qwen-cli --jsonl
```

一个 `--agent` 把任务派给 Codex / Claude Code / Qwen / Kimi / CodeBuddy / OpenCode 或 Lynn 自身,统一吐 Fleet JSONL。安全边界守在 Lynn 侧(ownership / forbidden-glob / diff 校验 / gate),不依赖外部 worker 自觉。

成功信号 = `gate.finished.ok`;硬失败 = `worker.violation` 或 `worker.error{recoverable:false}`。完整规范(BYOK 配置 / agent 适配表 / 全事件 schema / code tools)见 [`docs/ops/lynn-cli-agent-contract.md`](docs/ops/lynn-cli-agent-contract.md)。

## 🆕 近期更新

<details>
<summary><strong>Lynn v0.81.0</strong> · 2026-06-06 · StepFun 穷尽最优 + 工具扫描守卫 <em>(最新)</em></summary>

**GUI 与 CLI 同步发版**:
- ⚡ **StepFun 3.7 Flash 专项 best 模式**:`/goal`、`/best`、`Lynn code --best` 默认进入 300 步穷尽预算,开启 ultra 分解、并行原子 worker、对抗验收、auto-verify 和 checkpoint/resume,目标是“最好结果”,不是少跑几步。
- 🧱 **编排/分派/验收和 atomic loop 合流**:宏观任务先拆成独立子任务与依赖波次;每个 worker 内仍坚持一轮一动作、工具结果 ledger、计划契约、工具预算和 max-steps 补验,防止 StepFun 高速工具链变成工具风暴。
- 🧭 **不做答案兜底、不抢模型输出**:harness 只负责拆步、调度、验证、修复和记录;不会注入链式 system hint,也不会让路由替模型选择最终回答。
- 🧠 **默认云端 StepFun,本地模型显式启用**:StepFun 3.7 Flash 继续作为主路由;本地 9B 只在用户明确启用时启动,默认不占 GPU/统一内存。
- 🧊 **端侧 9B 运行策略**:KV cache 复用、warm pool 默认关闭、空闲自动 unload、小上下文、稳定前缀、3-5 个工具 schema、底栏本地 TPS 和失败升云 StepFun。
- ⚙️ **本地 35B/Spark 定位清晰**:35B/Spark 是显式高端本地档与第三兜底,不是默认主路由,避免误伤普通用户机器。
- 🧰 **CLI 工具扫描守卫**:交互式工具里禁止默认执行 `find / ...` 这类全盘扫描;glob 遇到 `.Trash` 或权限目录会跳过并记录,不再把整轮弄失败。
- 🧪 **门禁覆盖**:Brain V2、CLI toolchain/cache/file-size/pack/install、runtime answer/context、本地模型策略测试全部纳入发布前检查。

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"
```

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.81.0)

</details>

<details>
<summary><strong>CLI v0.80.6</strong> · 2026-06-01 · 前置缓存可见 + 长任务稳定性热修</summary>

**CLI-only 热修,GUI 仍为 v0.80.1**:
- 💾 **前置缓存命中可见**:借鉴 Reasonix 的 prefix-cache 思路,stable prefix / resume history / volatile runtime / current user 分层固定;usage、session、replay 和 `Lynn cache doctor --json` 会显示 `prefix-cache ... hit`,但不在聊天 UI 里显示 ctx% 焦虑条。
- 🧱 **长任务运行时压缩**:`Lynn code --long` 在工具循环中自动压缩旧消息,保留原始目标、当前计划和最近工具结果;JSONL 会发出 `code.runtime.compacted`,人类 TUI 会显示轻量信息卡。
- 🔁 **Brain 早期断流自动重试**:如果 SSE 在任何可见内容/工具调用前断开,CLI 会指数退避重试;一旦已经开始输出,不会重试以避免重复半轮工具调用。
- 🧭 **计划与工具卡片继续打磨**:`update_plan` 和 resume 计划回显使用 Claude Code 风格 plan card,工具/路由/压缩状态保持左 gutter 卡片风格。
- 🧪 **门禁覆盖长跑压缩路径**:`cli-longrun-smoke` 会制造大工具结果并要求出现 `code.runtime.compacted`,避免长任务稳定性只停留在单测。

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz"
```

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.80.6)

</details>

<details>
<summary><strong>v0.80.1</strong> · 2026-05-30 · CLI Worker Fleet + StepFun/MiMo Brain Route</summary>

**Lynn 有史以来最重要的编程版本**:
- 🖥️ **Lynn CLI / Lynn Code**:新增 Ink TUI、流光等待、Markdown/代码高亮、真实 diff 预览、多行输入、图片/音频/视频附件、`Lynn code -p ... --json` 无交互调用和 `Lynn agents` 机器可读命令面。
- 🧭 **GUI Fleet 指挥台**:桌面端可以 fan-out 派单到多个 CLI worker,显示 stdout/stderr、测试、diff、越界红灯、gate 状态,并支持 gated merge 到目标分支和远端 push。
- 🧠 **Brain V2 默认路由**:StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算) → MiMo V2.5 Pro/Omni → Spark Qwen 3.6 35B A3B。StepFun 负责高速文本与编码主路,MiMo 接多模态兜底,Spark 接本地零成本兜底。
- 🔗 **链式工具与搜索加固**:工具结果显著性注入、链式工具 hint、tool-storm 抑制、pre-search/web_search 代理和搜索源展示补齐,降低多步工具漂移。
- 💾 **长任务续跑与前置缓存纪律**:CLI 会话 JSONL、checkpoint、帧恢复、计划重建、原始目标钉住、git 快照和 stable context layers 一起支撑长任务稳定续跑;cache telemetry / prefix drift 进入日志和 metadata,不增加用户焦虑。
- 🧊 **本地 9B 改为显式启用**:本地 Qwen3.5-9B MTP 不再随启动自动占用约 6GB 显存/统一内存;用户点击启用时才下载/启动,并只在本地模型入口提示首次暖机较慢。
- 📦 **CLI 镜像安装与发布门禁**:Node 要求、CDN tarball、`Lynn`/`Lynn code`/`Lynn agents` 启动命令和 headless contract 写入 README、CLI README、release notes 与 release static gate。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.80.1)

</details>

<details>
<summary><strong>v0.79.9</strong> · 2026-05-29 · Risk Boundary Split + Search Source UI</summary>

**稳定性与维护成本下降版**:
- 🧩 **五个高风险中枢拆分**:`InputArea`、`stock-market`、`mcp-client`、`bridge-manager`、`engine/agent` 已拆出稳定边界,降低后续改动冲突和回归面。
- 🔎 **搜索工具更可解释**:web search 默认优先走 brain v2 本地 proxy,MiMo/GLM key 不进客户端;聊天工具卡支持展开查看综合答案与搜索源。
- 🧭 **本地模型升级窗口**:默认仍是 Qwen3.5-9B Q4_K_M imatrix MTP;旧版 9B GGUF 会显示为“可升级到 9B MTP”,不会误判为默认就绪。9B/35B 下载入口指向 ModelScope MTP 仓库,启动默认保持 MTP + thinking-on,并在模型卡标注 DGX Spark TPS 区间。
- 🛡️ **中枢回归继续收紧**:session event、tool runtime、dynamic prompt、MCP transport、bridge streaming/attachment 和搜索源摘要都补了 focused tests。
- ✅ **发布门禁**:V0.79.9 候选已通过 typecheck、runtime typecheck、全量 vitest、三段构建与 release regression 门禁。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.9)

</details>

<details>
<summary><strong>v0.79.7</strong> · 2026-05-28 · LynnEngine TS + 最后中枢收口</summary>

**V0.79 最后中枢 TypeScript 收口版**:
- 🧱 **LynnEngine 门面迁入 TS**:`core/engine` 已从 JS 迁入 TypeScript,agent/session/config/model/plugin 组合入口进入 runtime typecheck。
- 🔁 **兼容旧入口**:历史 `HanaEngine` import 保留为 `LynnEngine` 的别名,插件和旧代码无需立即改动。
- 🧰 **工具安全边界纳入类型检查**:tool guard、工具别名、MCP 按需激活、sandbox 参数和事件广播边界补齐类型外壳。
- 🧭 **前序中枢迁移保持稳定**:`server/routes/chat`、`core/session-coordinator` 与 `core/agent` 仍在同一 release gate 下回归。
- 🧭 **本地模型口径不变**:默认仍是 Qwen3.5-9B Q4_K_M imatrix MTP;4B 保持低配降级,继续提示 thinking-on 风险。
- ✅ **发布门禁**:V0.79.7 合入后通过 `typecheck:runtime`、全量 `typecheck`、全量 `npm test`、release static/UI/live regression 与打包公证门禁。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.7)

</details>

<details>
<summary><strong>v0.79.3</strong> · 2026-05-25 · TypeScript 安全迁移 + 公证包</summary>

**V0.79 架构安全推进版**:
- 🧱 **TypeScript 迁移继续推进**:`server/chat` 多个叶子 helper、`server/routes` 轻路由、`shared` runtime 工具与配置迁移到 TS,减少字符串 typo 和隐式 `unknown` 进入热路径。
- 🔎 **更稳的 release gate**:V0.79.3 合入后通过全量 `npm test`、`typecheck`、`typecheck:runtime`、server/main/renderer 构建与目标回归测试。
- 🧭 **本地模型口径不变**:默认仍是 Qwen3.5-9B Q4_K_M imatrix MTP;4B 保持低配降级,继续提示 thinking-on 风险。
- 🧾 **聊天与 artifact 热路径更容易维护**:stream emitter、turn state、artifact recovery、tool summary、voice fallback 等模块进入 TS 边界,为后续拆 `chat.js` 和 core 做铺垫。
- 🧪 **core 大迁移延后**:`core/session-coordinator.js`、`core/engine.js` 等大文件不塞进本次包,避免为追求 JS 占比牺牲发版稳定性。
- 📦 **macOS 三重校验完成**:Apple Silicon / Intel DMG 已签名、公证、stapled,并通过 Gatekeeper 校验;Windows 安装包以后续 Release 可见资产为准。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.3)

</details>

<details>
<summary><strong>v0.79.2</strong> · 2026-05-25 · 稳定性补丁 + TypeScript 迁移基建</summary>

**V0.79 稳定收口补丁**:
- 🧭 **本地模型引导维持 9B 默认**:继续默认 Qwen3.5-9B Q4_K_M imatrix MTP,4B 只作为低配降级并保留 thinking-on 风险提示。
- 🌦️ **天气/实时工具链路加固**:天气回答按工具返回的绝对日期与降水描述输出,避免把“未来两天/明后天”解释错。
- 🔁 **Brain v2 fallback 更稳**:Spark APEX-MTP fallback 修正模型 ID、默认关闭 thinking,并把本地 provider health probe 从冷启 800ms 误判加固为可配置超时。
- 🧾 **Deep Research artifact 统一**:本地模型、BYOK 和默认模型的 HTML 报告统一落为聊天内可点击预览卡片。
- 🧱 **架构债务清扫**:`brain-v2-mirror` 完成 TypeScript island 后继续收紧热路径类型;`server/chat` 叶子模块与 `core` provider/LLM contract 增加 TS 迁移前的类型边界。
- ✅ **发布门禁**:`npm test` 全量通过,新增 `typecheck:runtime`,brain-v2 `tsc + 104 tests` 通过,release preflight 覆盖构建与回归。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.2)

</details>

<details>
<summary><strong>v0.79.1</strong> · 2026-05-25 · 默认本地模型保持 Qwen3.5-9B MTP,4B 低配降级</summary>

**本地模型默认档更换**:
- 🧠 **默认 Qwen3.5-9B Q4_K_M imatrix MTP**:5.38 GB · 24GB 显存/统一内存推荐 · MTP 加速 · thinking-on 稳定性优先。4B 复测确认 thinking-on 有长思考后无正文风险,不再作为默认引导模型。
- 🎚️ **三档硬件分级**:
  - **默认 (24GB 显存/统一内存+)**:Qwen3.5-9B Q4_K_M imatrix MTP — 质量更强,带 MTP 加速
  - **低配降级 (8~16GB 可选)**:Qwen3.5-4B Q4_K_M imatrix (Lynn) — 建议 thinking-off,thinking-on 可能长思考后无正文
  - **高端 (24GB 显存/统一内存+)**:Qwen3.6-35B-A3B Q4_K_M imatrix — MMLU 90.40% / GPQA Diamond 80.70% · Lynn 校准 · 21 GB
- 🔁 **平滑迁移**:旧 4B 默认配置自动回到 9B MTP;4B 保留为显式低配降级。
- 🧾 **深度调研 HTML 报告**:本地 9B、BYOK 和默认模型都会生成聊天内可点击预览的 HTML 报告;本地/部分 thinking 模型遇到空正文会自动 no-think fallback。
- 🛡️ **架构与安全刷新**:聊天主链拆分为更小的服务模块,本地 GGUF 下载增加源地址/文件类型校验,模型状态与 token 文案统一到 provider state,避免 4B/9B 状态误导。
- ✅ **测试矩阵**:9B MTP、GPT-5.4、默认模型安装版 smoke 全绿;Deep Research 三路 HTML artifact 门禁全绿;4B thinking-on 风险已在 Spark 复现并写入模型说明。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.1)

</details>

<details>
<summary><strong>v0.79.0</strong> · 2026-05-22 · 本地 9B 离线推理 + 本地模型管理器</summary>

**本地模型大版本**:
- 🧠 **本地 9B MTP,日常离线用**:Qwen3.5-9B Q4_K_M imatrix MTP 成为一键安装的默认本地模型路径,授权后自动准备 llama.cpp、下载/校验 GGUF、启动本地 OpenAI `/v1` 端点并注册模型。
- 📦 **本地模型管理器**:设置 → 模型 支持应用内下载 35B 推荐 GGUF、导入用户自己的 GGUF、查看本地端点、停止模型释放内存。
- ⏳ **暖机反馈**:本地模型首次加载权重和预热上下文时会给出 30-60 秒提示、阶段状态和等待动效,避免用户误以为卡死。
- 🧭 **Brain V2 迁移**:老用户的旧 Brain endpoint 会自动迁移到 V2 canonical;GLM Coding Plan 使用专属 coding 端点;空答兜底只做可见修复,不提前干预模型输出。
- ✅ **回归门禁**:Full test suite `168 files / 1447 passed / 1 skipped`,TypeScript、renderer build、本地安装与 GUI smoke 通过。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.79.0)

</details>

<details>
<summary><strong>v0.78.1</strong> · 2026-05-12 · 中文财经搜索兜底 + Deep Research 体验热修</summary>

**搜索与 Deep Research 修复**:
- 🔎 **中文财经搜索兜底**:DuckDuckGo HTML 对中文热点/财经长查询返回 no-results 时,自动做中文查询简化并切换 Bing HTML fallback。
- 📈 **行情/新闻类问题更稳**:修复“可灵融资”“A 股受益标的”等中文财经调研容易搜不到的问题,Deep Research 不再把临时搜索失败伪装成最终结论。
- ⏱️ **超时文案更清楚**:Deep Research fetch 超时统一显示可读提示,前端等待时间与服务端任务窗口对齐。
- 🧩 **面板工程化**:Deep Research 面板与格式化 helper 抽离,补齐回归测试,便于后续继续迭代。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.78.1)

</details>

<details>
<summary><strong>v0.78.0</strong> · 2026-05-12 · Windows 启动热修 + Brain v2 新用户默认</summary>

**Windows 启动修复**:
- 🧩 **修复 SQLite migration 崩溃**:旧 `facts.db` 缺少 `category` 列时,启动不再因 `SQLITE_ERROR: no such column: category` 中断。
- 🛡️ **数据安全迁移**:先补齐 schema,再创建索引;覆盖安装即可修复,不需要删除本地记忆。
- ✅ **回归测试补齐**:新增旧库迁移测试,覆盖真实 crash.log 路径。

**Brain 默认策略**:
- 🧠 **新用户默认 Brain v2**:新安装/无本地配置的用户默认进入 Brain v2 链路。
- 🔁 **老用户不强迁**:已有 Brain v1 或自定义 provider 配置保持原样,升级不会覆盖稳定路径。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.78.0)

</details>

<details>
<summary><strong>v0.77.11</strong> · 2026-05-09 · Deep Research 桌面入口 + 质量复核 + 会话持久化</summary>

**Deep Research 体验**:
- 🧠 **新增 `深研` 入口**:输入框底部新增 Deep Research 按钮,空输入展示引导,有输入则进入深度调研链路并生成可预览结果。
- 🧪 **质量地板**:对 `A3B` 这类容易误判的缩写和低可信 winner 做拒绝输出,不把不稳定答案伪装成结论。
- 📌 **结果可追溯**:回答尾部显示 Deep Research 质量复核状态、winner 和候选模型评分。

**本地会话与工程化**:
- 💾 **深研结果写入会话**:`/api/deep-research` 支持 `sessionPath`,前端触发的 user/assistant 消息会真实追加到 JSONL,切会话/重载不再丢。
- 🧩 **显式能力入口**:Deep Research 不抢占默认聊天链路,用户需要时手动开启。
- 📊 **Benchmark 入仓**:Tool-abstain / Qwen3.5 vs Qwen3.6 实验文件归档到 `tests/benchmarks/`,便于后续复现。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.11)

</details>

<details>
<summary><strong>v0.77.10</strong> · 2026-05-08 · Brain v2 镜像同步 + 伪工具恢复 + Release 门禁加固</summary>

**Brain v2 与调研链路**:
- 🧠 **Brain v2 镜像代码入仓**:把远端 verifier / deep research / agent checkpoint 相关镜像代码同步进仓库,避免只靠服务器热修。
- 🧪 **Deep Research 质量地板**:低分候选不会被直接当成最终答案,后续接主链前先保留为受控能力。
- 🧭 **只读伪工具恢复**:对天气、行情这类只读工具,模型误输出伪工具文本时会转成真实工具调用并给出可见依据。

**本地任务与代码门禁**:
- 🛠️ **Bash 恢复模块迁出**:把命令恢复逻辑从 `chat.js` 拆进独立模块,继续压缩主路由复杂度。
- ✅ **代码修复验证补写**:代码诊断类回答如果缺少明确验证提醒,会自动补上可复制验证步骤,避免“看起来修了但没让用户验证”。
- 📊 **Tool Abstain V9 benchmark 入仓**:保留可复现 harness / question,把临时运行产物移出测试目录。

**发布与下载**:
- Release、更新清单和镜像站下载链接统一指向 v0.77.10。
- 全量 release regression 继续作为发版阻断门禁。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.10)

</details>

<details>
<summary><strong>v0.77.9</strong> · 2026-05-07 · 调研合成加固 + DOCX 质量门禁 + Turn 状态收口</summary>

**调研与长报告**:
- 🧠 **Brain v2 多轮调研合成加固**:调研类任务在多轮工具调用后会进入强制合成轮,避免只输出“继续深挖/摘要太粗”的进度文字。
- 📚 **证据账本与拆题清单**:服务端调研链路会保留工具来源、查询、片段和日期线索,让最终报告更容易整合成可读结论。
- 🧾 **短答门禁**:报告、DOCX、受众研究等任务如果只生成过短进度说明,会触发合成兜底,不再把半成品当最终答案。

**DOCX 与本地产物**:
- 📝 **DOCX 质量门禁**:生成 Word 前会检查内容长度、悬挂表格、进度占位语和报告完整性,避免输出没写完的 `.docx`。
- 🔗 **Brain 模型差异化处理**:Brain 任务跳过浅层本地预取,把证据收集交给 Brain v2;非 Brain 模型保留原有客户端兜底。

**稳定性与结构收口**:
- 🧹 **Turn timer 统一管理**:把 chat route 中散落的 timer 清理逻辑迁入 `stream-state`,减少 retry / stale stream / turn_end 的状态漂移。
- 🛡️ **伪工具可见兜底**:Brain 伪工具泄漏不再静默吞掉,会给出可见失败说明;非 Brain 模型仍保留原有恢复策略。

**测试**:
- 全量单测 `1209 passed / 1 skipped`。
- TypeScript、lint、release regression 和 UI smoke 会作为本次发版门禁继续执行。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.9)

</details>

<details>
<summary><strong>v0.77.8</strong> · 2026-05-06 · HTML Artifact 恢复 + 粘贴体验 + 伪工具收口</summary>

**HTML 报告与 Artifact**:
- 🧩 **恢复未展示的 HTML Artifact**:修复 `create_artifact` / `create_report` 已生成 HTML,但缺少 tool result 时聊天框不显示卡片的问题。
- 🕰️ **历史会话可补救**:重新加载旧会话时,会从 assistant tool call 中恢复 HTML 卡片,避免长报告“生成了但消失”。
- 🧹 **卡片去重**:按标题、类型和内容去重,防止重复 Artifact 刷屏。

**输入与复制体验**:
- 📋 **多行粘贴修复**:修复多行内容粘贴到 Lynn 输入框时被吞或只保留部分内容的问题。
- 🧷 **复制 fallback**:在 `navigator.clipboard` 不可用的环境中,复制按钮会走 textarea fallback。
- 🔕 **减少执行提示噪音**:移除执行型任务的低价值 inline notice,让用户更直接看到结果。

**伪工具调用收口**:
- 🧭 **零干预原则**:本地桥接和普通 session 不再额外 prompt 模型重试伪工具调用,只做泄漏清洗和上层兜底。
- 🛠️ **崩溃风险修复**:修掉零干预改造中遗留的 `retry = null` 路径。

**测试**:
- V9 benchmark 资料、runner 和复核材料进入 `tests/benchmarks`。
- 新增 Artifact recovery 单测,覆盖 JSON 参数、HTML 推断、去重和无效输入。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.8)

</details>

<details>
<summary><strong>v0.77.7</strong> · 2026-05-05 · 性能优化 + 危险命令识别加固</summary>

**性能优化(brain v2 端,所有用户立即受益)**:
- 🚀 **MiMo 快速模式透传**:Lynn ThinkingLevelButton 'off' 档自动经 `reasoning_effort: off` → brain v2 翻译成 MiMo `thinking:{type:"disabled"}`,**简单 chat TTF-Content -51%(2.7s → 1.3s)**,首字延迟近半。
- 🌐 **HTTP/2 上线**:nginx `api.merkyorlynn.com` 升级 ALPN h2,SSE over H/2 节省 head-of-line blocking,TTFB ~50-100ms 改善。
- 🔌 **undici Pool keep-alive**:brain v2 上游 16 connections + 30s keep-alive,**晚高峰并发 3 -23%**(12.7s → 9.7s),解决冷连接卡顿。
- 📊 **e2e smoke 实测对比**:HMAC valid -41% / stock_market -54% / web_fetch -38% / exchange_rate -33% / calendar -33% / 多场景 -23~54%。

**安全加固(客户端)**:
- 🛡️ **危险命令识别正则修**:`commandLooksLike{Delete,MoveOrCopy,Create,LocalMutation}` 之前漏识别 `/bin/rm`、`./rm`、`exec rm` 等绝对路径形式,confirmation card 高危标识缺失。修后:
  - leading set 加 `/`(识别 `/bin/rm` 等绝对路径)
  - trailing lookahead 严格 boundary(防 `rmdir-nope` 等文件名误识别)
  - 新增 **51 个参数化测试**(`tests/command-looks-like.test.js`)覆盖 17+11+10+4 positives + 6+3 negatives

**Brain provider reasoning 透传**:
- 🧠 **`engine.js`** 给 brain models 默认 `reasoning: true`,让 Pi SDK `reasoning_effort` 字段经标准链路透传到 brain v2(无需客户端额外改动)。

**巡检改造**:
- 📊 飞书 health-check 加 MiMo 头位 + 本地 GPU 路由重命名 + Kimi K2.6 (kimi-for-coding API) 替 K2.5 + brain v2 /api/v2 健康检测。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.7)

</details>

<details>
<summary><strong>v0.77.6</strong> · 2026-05-05 · Brain v2 重写上线(底层换装,体感无感)</summary>

**幕后大重构 — 用户视角无感**:
- 🧠 **Brain v2 上线**:服务端 11000+ 行单文件 v1 整体替换为 5 模块拆分的 v2(< 2000 行生产代码),OpenAI 兼容 + Lynn 客户端协议完全保留。
- 🚀 **MiMo `enable_search:true` 头位主链**:简单 chat 2-5s,工具调用 5-10s,多轮 web_search 7-10s。
- 🛠️ **16 个 server tools 完整 port**:web_search / web_fetch / weather / exchange_rate / express_tracking / sports_score / calendar / unit_convert / create_artifact / create_pdf / stock_market / live_news / stock_research / create_report / create_pptx / parallel_research — 全部生产 e2e 验证。
- 🔧 **顺手修了 v1 隐藏 bug**:`create_pptx` 在 pptxgenjs 4.0.1 用 `{fill:{type:'solid',color}}` 实际报错,v2 改用现代 `{color}` API。
- 🎯 **客户端兜底链路 0 改动**:`<lynn_tool_progress>` 标记 + reasoning_content 流 + tool_calls SSE 字段全部跟 v1 字节级对齐。
- 🔐 **HMAC 签名复用 v1 device store**:旧客户端无感,新客户端走新 endpoint。
- 📊 **巡检挂上**:pulse 5min(/health + ping chat)+ smoke 2h(4 核心场景),失败飞书告警。
- 🔄 **自然灰度**:v0.77.6 走 brain v2 (`/api/v2/`),v0.77.5 及之前继续走 v1 (`/api/`),双链共存 30 天后下线 v1。

**质量门禁**(全过):
- 90 vitest 单测 + 16 e2e smoke 场景
- 服务端 TypeScript / Lint / Build 全过

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.6)

</details>

<details>
<summary><strong>v0.77.5</strong> · 2026-05-02 · 长朗读可中断 + 微信桥接稳定性 + 语音延迟优化</summary>

**朗读与语音**:
- 🛑 **朗读现在可以随时停**:聊天页"朗读"按钮支持 toggle,长回复播报中再按一次立即停止;切换消息或关闭窗口也会自动停。
- ⚡ **语音首字延迟优化**:Brain text_delta → TTS 首段播放路径精简,首字到嘴时间下降。
- 🧯 **语音追加竞态修复**:修复"完整文字到了但语音只播了头一段"问题(B2 race),server 加 150ms grace 期 + pendingAppendQueue 双缓冲。

**桥接稳定性**:
- 🤖 **微信/飞书天气查询不再"空答"**:修复长对话历史下,A3B 输出被伪工具检测器误剥成空内容触发兜底文案的问题;现在剥空时回退到原文,保证用户至少看到回复。

**回归**:
- Unit / Integration / Voice runtime / TypeScript / Lint / Renderer build / Main build / Server build 全过

**Hotpatch #1 (2026-05-02)** — Windows 启动 ERR_DLOPEN_FAILED
- ⚠️ **Windows 包重发**:首次发版 Setup.exe 包含 darwin Mach-O `clipboard.darwin-*.node`,Win Node 启动时 dlopen Mach-O dylib 抛 `ERR_DLOPEN_FAILED` 直接崩(用户实测截图)
- 🔧 修复 `scripts/build-server.mjs` 加 sweep 阶段:Win build 移除所有 `@mariozechner/clipboard-darwin-*`(只保留当前 target platform 的 clipboard 子包,跟现有 koffi 逻辑同款)
- ✅ Win Setup.exe 重新签名 + GitHub Release / Tencent 镜像同步替换;`latest.yml` size/sha512 更新
- ✅ macOS dmg 不受影响(原本就只装 darwin 包)

**Hotpatch #2 (2026-05-04)** — Windows 启动 ERR_DLOPEN_FAILED(余波)
- ⚠️ **Hotpatch #1 不彻底**:虽修了 server bundle 的 `clipboard-darwin-*` 沾染,但 desktop 端 `desktop/native-modules/aec/lynn-aec-napi.darwin-arm64.node`(V0.79 Phase 2 AEC native module 仅 Mac arm64 prebuild)被 electron-builder `files` glob `*.node` 一并打进 Win Setup.exe,Win Node 启动 dlopen Mach-O 仍崩(用户实测截图)
- 🔧 修复 `scripts/fix-modules.cjs` afterPack 钩子加 native-modules platform-sweep:扫 `app.asar.unpacked/desktop/native-modules/**`,根据当前 build target 删跨平台 napi-rs 标准命名 .node(`*.{darwin|win32|linux}-*.node` 不匹配当前平台的)
- ✅ Win Setup.exe 体积 204.5MB → 204.4MB(去除 132KB darwin-arm64.node);GitHub Release / Tencent 镜像同步替换;`latest.yml` size/sha512 更新
- ✅ macOS dmg 不受影响(原本就保留 darwin-arm64 prebuild)

**Hotpatch #4 (2026-05-04)** — Intel Mac 启动 ERR_DLOPEN_FAILED(better-sqlite3 ABI 跨架构 build 拿错 Node 版本)
- ⚠️ **场景**:Hotpatch #3 ship 出去后,Intel Mac 用户启动 Lynn 立即崩 — `better_sqlite3.node was compiled against NODE_MODULE_VERSION 115. This version requires NODE_MODULE_VERSION 127`(ABI 不匹配)
- 🔧 **真因**:`scripts/build-server.mjs` 跨架构 build(arm64 host → x64 target)时,用 host Node 跑 npm install 让 prebuild-install 下载 better-sqlite3 prebuilt,但**没指定 Node 版本** → prebuild-install 用 host 的 Node v20 ABI 115 拿了 v20 prebuilt,放进 dist-server/mac-x64/(那里 node 二进制是 v22 ABI 127)→ ABI mismatch 立崩。Apple Silicon 用户没事(host 跟 target 同 v22)。Hotpatch #1 sweep 验证只查 file 类型对不对,不查 ABI,所以没拦下来
- ✅ **修复**:`scripts/build-server.mjs` 在跨架构 env 加上 `npm_config_target=22.16.0` + `npm_config_runtime=node` + `npm_config_disturl=https://nodejs.org/dist` — 强制 prebuild-install 下载 v22 ABI 127 的 prebuilt
- ✅ **验证**:用 `dist-server/{plat}/node` 实际 dlopen 各 .node 测试,arm64 + x64 双 mac 都 FULL OK(`new Database(':memory:')` 真实例化)。Win Setup.exe 同根因(从 arm64 cross-build 到 win32 x64),同时修
- ✅ Mac arm64 / Mac Intel / Win x64 三个包重 build + 重签 + 重公证 + 重镜像同步

**Hotpatch #3 (2026-05-04)** — 删除文件类任务"确认删除"无效老 BUG + brain 嘴炮防御 + 路由元数据泄漏修复
- ⚠️ **场景 1**:用户发"删除下载文件夹 zip 文件"→ 模型空答 → Lynn 兜底文案承诺"回复'确认删除'即触发执行" → 用户回"确认删除" → **再次空答**(老 BUG,实际文件根本没删);即使加了上下文重注入,brain(Qwen3.6-A3B)仍可能"嘴上答应'明白,直接执行'但不真调 bash"或返回 placeholder `bash {"command": "command"}` 占位字符串
- ⚠️ **场景 2**:用户发研究类长任务(如"帮我整理中国各个私董会的价格、人数、特点")→ 模型空答 → Lynn 兜底文案末尾出现 **"类型: utility"** 元数据泄漏(用户实测截图)— 这是 brain 把内部 retry prompt 里的"任务类型:utility"echo 回了用户可见文字
- 🔧 **真因 1**:兜底文案撒了个谎 — Lynn 没有任何机制把上一轮的"待删除目标"持久化到 session,4 字"确认删除"独立 prompt 进入 brain 时完全无目标信息;且 brain 工具路由偏好抖动(V8 CODE-02 已记录),给到强约束 prompt 仍可能选择空答/嘴炮/占位 placeholder
- 🔧 **真因 2**:`buildEmptyReplyRetryPrompt` 内部 retry prompt 包含 `任务类型:${routeIntent}`(本意给 brain 上下文),但 brain 抖动时会把这一行作为"系统说明文字"echo 回用户 — 跟 `pseudoToolSteered` 路径里的 reflect 标签泄漏同款污染
- ✅ **三段式安全网修复**(确保用户的"确认删除"必有真删):
  1. **上下文持久化**:用户发删除类 prompt → 立即把 `originalPrompt + requirement` 暗存到 `ss.pendingMutationContext`(10 分钟 TTL);下一轮命中"确认删除/确认/yes/好的/go ahead" 等确认短语 → 自动用上一轮 prompt **重新注入** brain 附带严格执行要求 + 已知目录别名 + 删除安全要求(走 `buildLocalMutationContinuationRetryPrompt`)
  2. **嘴炮升级 retry**(Path A):rehydrate 后 brain 仍空答/嘴炮/`model_tool_error`/placeholder → Lynn 自动 intercept turn close 并 schedule 一次 internal retry,prompt 升级为"严重升级"级别(`buildPostRehydrateEscalationPrompt` — 明令禁止 `command`/`placeholder` 字面占位 + 禁止伪工具 + 禁止"明白/好的"嘴炮)
  3. **确定性 fallback**(Path B):升级 retry 仍未真删 → Lynn server-side **直接合成** `find ${aliasPath} -name '*.${ext}' -delete` 命令,不再依赖 brain,通过 `executeRecoveredBashCommand` 走 confirmation 卡片让用户审一道防误操作
  4. **真删自动清 context**:检测到 `rm`/`trash`/`find -delete` 命令在 `lastSuccessfulTools` 中成功 → 立即清 `pendingMutationContext` 防污染下一轮
  5. **路由元数据泄漏 双层修复**:① `buildEmptyReplyRetryPrompt` 删掉 `任务类型:${routeIntent}` 那行,改写成"不要输出 任务类型/类型/Route/Kind 这类标签"反向指令;② 新增 `stripRouteMetadataLeaks` 用于持久化 assistant 文本的回放路径(`extractLatestAssistantVisibleTextAfter`),即使旧 session history 含残留也会被剥掉
- ✅ E2E dev 多轮验证(在 brain 持续抖动状态下):`PENDING-DELETE-REQUEST v1` 100% 触发 / `MUTATION-CONFIRM-REHYDRATE v1` 100% 触发 / `POST-REHYDRATE-ESCALATE v1` 升级 retry 100% 触发(brain 仍嘴炮时);Path B `POST-REHYDRATE-DETERMINISTIC v1` 在 Downloads/Desktop/Documents 已知目录场景能正确合成 `find ... -delete` 命令
- ✅ +17 单测覆盖:存储/消费/确认短语/TTL/无关输入/真删自动清/`find -delete` 识别/escalation prompt 的禁令措辞/路由元数据 strip / retry prompt 不再嵌入 routeIntent

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.5)

</details>

<details>
<summary><strong>v0.77.4</strong> · 2026-05-01 · 语音小波形 UI + 中断修复 + 工具链稳定性</summary>

**语音、工具与报告体验**:
- 🎛️ **轻量语音浮层**:语音运行时改成小型波形卡片,减少闪动和遮挡,不再把转写/回复大卡片压到输入区上方。
- 🧯 **语音中断修复**:修复 THINKING/SPEAKING 中断时状态崩溃、旧 turn 阻塞新一轮录音、ASR 失败后残留"理解中…"的问题。
- 🎙️ **ASR 兼容增强**:Qwen3-ASR 增加语言归一、WAV MIME 识别和请求超时,降低转写链路卡死概率。
- 🧰 **本地工具链加固**:继续修补伪工具、坏 bash、文件移动/删除后无反馈和危险操作授权链路。
- 🌦️ **实时数据证据修复**:天气/行情类回答必须基于有效字段,减少抓到首页导航却当成结果的情况。
- 🌐 **翻译与报告入口**:补齐聊天内翻译入口、HTML artifact 安全渲染和 PNG 导出链路。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.4)

</details>

<details>
<summary><strong>v0.77.3</strong> · 2026-05-01 · Lynn 语音运行时 + 启动白屏修复 + 长回复朗读</summary>

**语音与启动稳定性**:
- 🎙️ **Lynn 语音浮窗**:新语音入口正式显示 Lynn，不再沿用 Jarvis 命名。
- 💬 **接入正常聊天链路**:录音转写后进入当前聊天框，工具调用、记忆、历史记录和反思都沿用打字聊天路径。
- 🗣️ **默认中文女声恢复**:回复语音走 CosyVoice 默认中文女声，并修复 22.05kHz WAV 到 16kHz PCM 播放链路。
- 🔢 **中文数字朗读修复**:日期、温度、百分比、股票代码等数字会先转成中文读法，避免 five/two 混入中文播报。
- 📚 **长回复持续朗读**:长回答会按短句/逗号自动切成小块排队合成，单块失败会继续拆小块播放。
- 🪟 **启动白屏修复**:修复 React selector update depth 和 splash 丢 app-ready 后卡住的问题。
- 🧩 **打包链路加固**:插件独立加载、`build:server` npm 镜像损坏重试和本地冷启动验证都已补齐。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.3)

</details>

<details>
<summary><strong>v0.77.2</strong> · 2026-04-29 · 天气证据门禁 + HTML 报告风格 + PNG 导出</summary>

**报告与实时数据体验**:
- 🌦️ **天气证据门禁**:天气工具必须拿到天气状态、温度/降雨等字段才算成功,不再把天气网站首页或导航菜单当结果。
- 📰 **漂亮 HTML 报告**:`create_report` 支持 `editorial-paper` / `finance-dark` / `magazine` / `clean-briefing` 风格,深度报告默认 editorial-paper。
- 🖼️ **Artifact 导出 PNG**:HTML 报告可在聊天中预览、浏览器打开,并导出 PNG 方便发微信、知乎、小红书或文档。
- 🎨 **frontend-design skill**:内置 Apache 2.0 的 frontend-design skill,指导模型生成更像成品而不是模板的 HTML。
- 🧯 **Turn quality gate 加固**:后台/空答/工具兜底路径更稳,减少“Lynn 还在说话”和空转。
- 🧼 **流式伪工具清理增强**:统一 `<web_search>` / `<weather>` / `<bash>` 等伪工具标签清理。
- 🧩 **运行时稳定性补丁**:修复 stream LRU、EventBus 异步异常、ChannelRouter 并发锁和 Plugin unload 清理。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.2)

</details>

<details>
<summary><strong>v0.77.2</strong> · 2026-04-29 · 危险操作授权 + 伪工具兜底 + 本地任务反馈加固</summary>

**执行与安全体验**:
- 🛡️ **危险操作授权卡**:执行模式下涉及删除、sudo、批量移动、覆盖等高风险命令会弹出确认。
- 🎨 **米色授权 UI**:授权卡改为 Lynn 风格,不再出现突兀的深色 Codex 卡片。
- 🧰 **本地任务反馈加固**:文件整理、删除、移动等任务执行后必须给用户可见结果,不再"命令跑了但没回复"。
- 🧼 **伪工具泄漏修复**:模型输出 `<web_search>` / `<bash>` 这类假工具标签时会被识别并兜底处理。
- 🔁 **空答与 retry 兜底**:工具失败、模型只输出开场白或 retry 后仍无正文时,会给出明确可恢复提示。
- 📁 **文件任务识别增强**:优化下载/桌面目录别名、zip/excel/pdf 等文件识别和安全删除路径。
- 🧪 **Release Regression Gate**:继续覆盖工具调用、文件操作、伪工具泄漏、thinking 泄漏和 UI smoke。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.2)

</details>

<details>
<summary><strong>v0.76.9</strong> · 2026-04-28 · DeepSeek v4 + 路由重排 + brain 工具兜底 + UI 流式修复</summary>

**Hotpatch #1 (2026-04-28 下午)**:
- 🛡️ **TOOL-FAILED-FALLBACK v1**:工具调用失败 + 模型只输出"我来查一下"开场句就 turn_end 时(典型 live_news / stock_market 失败),自动 inject 系统提示**强制重答**——禁止再调工具 / 给审慎估计 + 明确标注「基于公开常识/未实时核实」/ 否则诚实告知未查到。修复"问完了 Lynn 只回半句话不完成任务"的 dogfood bug。
- 🧪 **新增 262 行测试**(`tests/chat-route-events.test.js`)覆盖 TOOL-FAILED-FALLBACK 触发条件 + retry 路径 + locale。

**模型 / 路由 ABD 重排**:
- 🚀 **DeepSeek API 升级**:`deepseek-chat` → `deepseek-v4-flash`(非思考),`deepseek-reasoner` → `deepseek-v4-flash`(思考模式,带 `thinking:{type:"enabled",reasoning_effort:"high"}`),新增 `deepseek-v4-pro` provider(brain 可路由)。
- 🧠 **thinking 字段强制声明**:v4-flash 默认会进 thinking 烧 token,brain chat 链路注入 `thinking:{type:"disabled"}`,reasoner 链路注入 `enabled+high`,不再返回空内容 finish=length。
- 🛣️ **chatOrder 重排**:Spark FP8 第 1(轻任务本地优先) → 本地 GPU wrapper → DeepSeek V4-flash → GLM/MiniMax/Step → K2.6 倒数第 2 → K2.5 末位。
- 📚 **新 creativeOrder**(小说/章节/古风/散文/诗歌/文学翻译/润色/文风/写一篇)→ DeepSeek V4-pro 第 1 + K2.6 第 2 + GLM-5-Turbo。
- 📜 **complexLongOrder K2.6 第 1**(超长上下文 200K+ 唯 K2.6 支持)→ V4-pro → V4-flash → 兜底链。
- 📦 **客户端 BYOK 兼容**:`lib/known-models.json` + `lib/default-models.json` 加 v4-flash/v4-pro 条目,旧名标 `deprecated:true + alias`。

**brain 工具链与超时兜底**:
- 🛠 **stock_research NaN sanitize**:Tushare 偶发输出非法 JSON `:NaN/:Infinity`,parse 前自动替换为 `:null`,不再触发 90s LLM fallback chain。
- ⏱ **web_search 25s 总 budget**:多源 race(DDG+Zhipu)+ WeChat+SearXNG fallback 全程不超过 25s,超时返回空让模型基于上下文回答。
- 🚫 **HK bail v2 严格 A 股代码白名单**:tsCode 必须 `60/00/30/68/8X/92.SH/SZ/BJ`,其余(89xxxx 基金 / 4 位 HK code / 美股)直接 bail 到 stock_market,**修"HK 700 → 890001 伪报告" bug**。
- 📊 **dataChunks guard**:深度研究上下文如果实测拿到 0 段真数据,**不再硬撑专业报告模板**误导用户,直接告知"未拿到真实数据,请改用普通查询"。
- 🌐 **realtime-info 多源补强**:金价 / 油价 / 行情等查询源补足,失败时清晰告知。

**UI / 客户端流式修复**:
- 🔤 **\</user> chat-template tag 不再漏到 UI**:streaming chunk 边界把 `</user>` 切成 `</us` + `er>` 时,加 buffer 缓冲到下一 chunk 拼接,ORPHAN_CLOSE_TAG_RE 才能正确命中 strip。
- 🛎 **慢工具进度提示**:工具调用 > 15s 自动 emit `tool_progress slow_warning` event,UI 不再"卡死"感。
- 🧰 **bash schema 三层兜底**:`extractToolDetail` + `TOOL_ARG_SUMMARY_KEYS` + `normalizeToolArgsForSummary` 全部加 `cmd/shell/script` 别名,Spark emit `{cmd:"..."}` 不再渲染成空 "执行 命令"。
- 🎤 **录音权限 ghost 检测**:录够 0.4s+ 但 blob<1KB 时识别为 macOS TCC 失效,提示用户去系统设置重授权 + 重启 app。
- 🔏 **install:local 不再丢权限**:sign-local.cjs 默认 Developer ID 而不是 ad-hoc,cdhash 跟 electron-builder 一致,**以后 install:local 不再让 macOS TCC 把 Lynn.app 当新 app**。
- 🎙️ **PressToTalk UI 优化**:按钮样式 + 状态机重构,长按锁定 + 录音中视觉反馈更稳。
- 🧱 **brain server 报告上下文增强**:`server/chat/report-research-context.js` 注入更结构化数据,模型生成报告更准确。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.9)

</details>

<details>
<summary><strong>v0.76.8</strong> · 2026-04-27 · BYOK-equality + Spark FP8 回退 + 文件管理修复 + bash schema 兜底 + 录音权限提示</summary>

**Hotpatch #3 (2026-04-28 凌晨)**:
- 🛠️ **bash 工具 schema 一致**:`extractToolDetail` / `TOOL_ARG_SUMMARY_KEYS` / `normalizeToolArgsForSummary` 全部加 `cmd/shell/script` 别名兜底,Spark emit `{cmd:"..."}` 不再渲染成空 "执行 命令"。
- 🎤 **录音权限友好提示**:录够 0.4s+ 但 blob<1KB 时识别为 macOS 麦克风 TCC ghost 失效,直接提示去系统设置重新授权 + 退出重开。
- 🔏 **install:local 不再丢权限**:`sign-local.cjs` 默认 Developer ID 而不是 ad-hoc,签名后 cdhash 跟 electron-builder 一致,**不再让 macOS TCC 把 Lynn.app 当新 app 让用户每次重装都重新授权**。
- 📝 **brain 长答稳定**(server-side):`max_tokens` simple 1500→4000 / longForm 6000→8000;`__longFormRx` 加"介绍/说说/讲讲/写一段/简介/教程..."等中文长答关键词;`temperature` 0.6→0.4 让重问同问题输出更一致。


- 🚨 **Spark 紧急回退 PRISM-NVFP4 → Qwen3.6-35B-A3B-FP8 + SGLang+MTP**: heretic 去 safety 流程附带破坏 tool-call decisiveness,curl 实锤 reasoning 死循环 2048 tok 不出 tool_call;FP8 + `首先` 注入 + NEXTN MTP 即时恢复。
- 🧠 **BYOK-equality 架构改造**: Lynn 客户端不再用"场景契约 + 预取 + 强制工具"抢方向,brain 跟 BYOK(GPT/Claude/Kimi)走同一套自主判断路径。
- 🔧 **文件管理任务分类修复**: "新建/移动/挪/整理 + 文件夹/目录/图片" 强制走 UTILITY/local_automation,不再被裸"图片"误判成 vision/multimedia。
- 🛡️ **brain 6 patches**(server.js): HYBRID-1 hasGpuTools→max=32K + HYBRID-3 reasoning guardrail + B1 `__needsFileTools` + B2 收紧 `__isFileEditIntent` + LYNN BYOK-equality + loop-breaker v4(只 log 不强制干预,允许合法多步 ls→mkdir→mv)。
- 🤖 **新模块 LLM Triage v1**: regex+Spark FP8 hybrid 分类器,5min cache,Spark 不可达自动 fallback regex。
- 🛠️ **bash args 归一**: tool-wrapper 自动把 query/cmd/shell/script 归一成 command,Spark 偶发 schema 错位有救。
- 🎤 **录音 min-size guard**: PressToTalkButton 拦截 <1KB blob 或 <0.4s 录音,防 sensevoice 500 EBML header 错位。
- ⌨️ **IME 三层 OR**: `isComposing || nativeEvent.isComposing || keyCode === 229`,中文最后一段不再被 Enter 提交时漏字。
- 🔇 **空答兜底**: 模型只 thinking 不出答案 → 显示"重试"按钮(5 locale 已加翻译)。
- 🔠 **i18n**: 设置页 Voice tab 显示"语音"(之前漏 5 个 locale 翻译)。
- 🚫 **伪 tool-call 检测 + 自动恢复**: 模型在 text 里写 `<web_search>...` / `web_search(query=...)` 等"调用语句"时,brain 强切回真工具流,user 不再看到崩溃文本。
- 🧪 **771/771 全测试 + 新增 30 regression cases** 锁住 file-move-image 永不再走 vision 误判。

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.8)

</details>

<details>
<summary><strong>v0.76.7</strong> · 2026-04-27 · TTS 端到端 + 语音 Phase 1 + CSP media-src 修复</summary>

- 🗣️ **TTS 播放打通**: SenseVoice ASR + CosyVoice 1.0 SFT(7 个内置 speakers),米色 🎤 按钮 → ssh tunnel → frp → DGX docker
- 🎙️ **B 模式长按锁定**: 长按 600ms 锁定连续录音,再点结束
- 🔌 **Provider Registry 框架**: 阿里全家桶默认 + 4 个 BYOK 备选(Faster Whisper / OpenAI Whisper / Azure / Edge TTS)
- 🔧 **CSP media-src 修复**: vite CSP_PROFILES 让 `blob:` URL 能被 Audio 元素加载(本次 release 真凶)
- 🛠️ **vite hono external**: server Vite config 让 plugin 动态 import 解析正常
- 🪟 **IME 不抖**: 中文输入候选切换稳定;thinking block 默认折叠
- 📦 **3 平台公证**: macOS Apple Silicon + Intel + Windows 全打公证,镜像站同步

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.7)

</details>

<details>
<summary><strong>v0.76.6</strong> · 2026-04-21 · 工具增强 + 研究路径 + OAuth + 715 测试全绿</summary>

- 📈 **stock-market 工具大改** (+425 行): 多数据源行情 + 容错 + 4 个新测试
- 🧠 **研究上下文扩展** (+428 行): 天气/股票数据结构化注入, 融合研究路径
- 🔧 **LLM 客户端重构** (+188 行): provider-aware 请求构建, 多 provider 更稳
- 💭 **ThinkTag/XingParser 扩展**: 思维链解析能力 +5 场景覆盖
- 🔐 **OAuth 路径修复**: Lynn OAuth provider id 正确映射到 auth.json
- 🎯 **串轮隔离 TURN-FENCE v1**: 上一轮 abort 无产出时自动系统隔离, 避免误读残留
- 🧪 **测试**: 4 新 + 7 扩展, `715/715 vitest all green`

[完整 Release Notes →](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.76.6)

</details>

<details>
<summary><strong>v0.76.5</strong> · 2026-04-21 · 乱码清洗 + 办公本地答 + vision arg 修复</summary>

- 乱码清洗机制: LLM 输出偶发乱码字符被拦截
- 办公本地答: 简单办公问题走本地预算计算, 避免 LLM 心算错
- Vision argument regression 修复 (9 tests)
- 工具 intent 收敛: 减少工具误触发

</details>

<details>
<summary><strong>v0.76.4</strong> · 2026-04-20 · ThinkTagParser v2 + FAKE-PROGRESS-GUARD v2 + 25s TTFT timer</summary>

- **ThinkTagParser v2**: 重构思考标签解析, 应对更多模型格式
- **FAKE-PROGRESS-GUARD v2**: 防止 LLM 编造 tool_progress 消息
- **25s TTFT timer**: 首 token 超时降级, 用户体验更稳
- **vLLM 切回真 A3B** (服务器侧): 修复上一版误用稠密模型
- QA 质量分从 1.3 → 4.42

</details>

<details>
<summary><strong>v0.76.3</strong> · 2026-04-19/20 · 真流式 + Diff 视图 + Brain 并发 3×</summary>

- 20 小时马拉松: 真流式重构, brain 10+ 补丁
- **vLLM 调优**: KV 池容量 4×
- **WritingDiffViewer**: 词级红删绿增, 专为写作设计
- **Loop-breaker v2**: 工具调用死循环检测
- **复查路由**: 跨 session 任务追踪

</details>

<details>
<summary><strong>v0.76.2</strong> · 2026-04-18 · Intel 死机修复 + 工具 alias + 中文 thinking</summary>

- 修复 Intel Mac 启动死机
- 工具名 alias 6 条 (read_file → read 等)
- 中文 thinking 命中率 91%
- ThinkingBlock R1 风格呈现

</details>

<details>
<summary><strong>v0.76.1</strong> · 2026-04-17 · 任务模式切换 + 按需 MCP</summary>

- **任务模式芯片**: ⚡ 自动 / 📖 小说 / 🖋️ 长文 / 🌶️ 社媒 / ⌘ 代码 / 💼 商务 / 🌐 翻译 / 🔬 研究 / 📝 笔记
- 社媒模式 7 个 slash 命令 (`/xhs` `/gzh` `/weibo` `/douyin` `/zhihu` `/hashtags` `/titles`)
- **按需激活 MCP 服务器**: 默认 0 个 MCP 工具, 要用再开, 不拖慢模型
- IME bug 修复
- GPU 64K context 支持

</details>

👉 [完整发版历史 · GitHub Releases](https://github.com/MerkyorLynn/Lynn/releases)

---

## Lynn 是什么

Lynn 是一个面向桌面用户的 AI Agent：**有记忆、有人格、会写作、能主动做事,也能调度代码任务**。

早期 Lynn 的重点是把 Agent 从命令行里拖出来,让写作者、研究者、运营、学生、创业者这些非程序员也能用起来。V0.80 开始,Lynn 会把这条路继续往前推:不是离开编程,而是把编程任务、研究任务和业务任务统一放进一个 GUI 调度台。

用过 Claude Code / Codex / Cursor 的,你会觉得 Lynn 熟悉但更像一个“指挥台”:它不只让一个 Agent 在一个终端里干活,而是把多个 CLI worker、多个 worktree、多个模型和多个任务合在一起管理。没用过这些工具的,你也能从 GUI 开始,逐步把代码、文档、研究和自动化工作交给 Lynn。

## Lynn 适合谁 / 不适合谁

**✅ 适合**

- 写作者（网文 / 公众号 / 小红书 / 知乎 / 论文）
- 研究员 / 学生党（整资料、跟项目进度、长期记忆）
- 运营 / 创业者（跨平台同步、多 Agent 分工、批量文案）
- 程序员 / 技术负责人（同时调度多个 CLI Agent、多个 worktree、多个测试门禁）
- 产品 / 增长 / 业务负责人（把调研、文案、数据分析和代码改动放进同一套验收流）
- 需要 **"AI 帮我处理本地文件"** 的非技术用户
- 想要一个**桌面端 AI 伙伴**的人（而不是浏览器标签页）

**❌ 不适合**

- 只想要代码补全 → 用 [Cursor](https://cursor.com) / [Trae](https://trae.ai)
- 只想要一个单 CLI Agent → 用 [Claude Code](https://claude.com/claude-code) / Codex CLI / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- 部署在服务器做多租户 → 用 [Hermes Agent](https://github.com/NousResearch/hermes-agent)

Lynn 做的是**桌面端、面向个人、有长期记忆、能写作、能编排多个 Agent/CLI worker** 的 AI Agent。它不和 Cursor 抢编辑器里的光标,而是把代码任务之外、代码任务之间、代码任务之后的调度和验收补齐。

## 三个和别家不一样的地方

### 🧠 1. 真正的长期记忆（不是 `memory.md` 那种）

Lynn 的记忆层是 **15 个模块、5000+ 行代码、SQLite + FTS5 全文索引 + 向量检索 + 关系图**。

<p align="center">
  <img src=".github/assets/memory-architecture.svg" width="100%" alt="Lynn 六层记忆架构">
</p>

- **毫秒级召回**："你上个月是怎么配 nginx 的来着" —— FTS5 在 10ms 内翻出三条相关对话
- **六层结构**：事实存储 / 深层记忆 / 用户画像 / 项目记忆 / 主动召回 / **技能蒸馏**
- **主动召回**：不等你问，根据当前对话关键词**自动把相关记忆注入上下文**
- **技能蒸馏**：复杂任务完成后（≥8 轮 + ≥3 次工具调用 + 检测到"完成"信号）自动提炼成可复用 Skill，冷却 6h 防抖，带中英双语完成/失败模式识别

### ✍️ 2. 专为写作做的 Diff 视图

大部分 Agent 改 Markdown 像改代码——给你一坨 `+/-` 行级对比。Lynn 不是。

- **WritingDiffViewer**：词级红删绿增、比例字体、逐段 ✓接受 ✗拒绝
- **✎ 手改**：不满意 AI 的版本，直接在段落里改成自己的
- **写作模式**：⇧⌘M 一键切换，聊天区加宽到 800px，右侧自动开 MD 预览，左侧 sidebar 自动收起
- **多视角叙事**：novel-workshop 技能支持罗生门式同场景多 POV 重写
- **对比外部修改**：你在 VSCode 里改了文件？点「对比外部修改」→ git HEAD diff → 同样的 WritingDiffViewer

写小说、写长文、写公众号、写小红书——散文友好，不是 GitHub 那套。

### 🎯 3. 任务模式切换（v0.76.1 新增）

输入框左下角的 ⚡ 芯片，点开一看就懂：

| 类别 | 模式 | 干什么 |
|---|---|---|
| 自动 | ⚡ 自动 | 按文件/内容自动选（默认） |
| 写作 | 📖 小说 · 🖋️ 长文 · 🌶️ 社媒 | 每个模式注入专属 persona |
| 工作 | ⌘ 代码 · 💼 商务 · 🌐 翻译 | |
| 学习 | 🔬 研究 · 📝 笔记 | |

**社媒模式自带 7 个 slash 命令**：`/xhs` `/gzh` `/weibo` `/douyin` `/zhihu` `/hashtags` `/titles`——点一下展开完整 prompt 模板，你只需要填主题。

同一个面板里还能 **按需激活 MCP 服务器**（v0.76.1 新增）——默认 0 个 MCP 工具（不拖慢模型），要用哪个点开关就行。

---

## 和 Cursor / Claude Code 横比

|  | **Lynn V0.80** | Cursor | Claude Code / Codex CLI |
|---|---|---|---|
| 定位 | **GUI 指挥台 + CLI Worker Fleet** | 程序员 IDE | 单 CLI Agent |
| 并行任务 | **✓ 多 worker / 多 worktree / merge queue** | 较弱 | 需人工管理 |
| 代码验收 | **✓ GUI diff + 测试门禁 + 发布流** | IDE 内 | 终端输出 |
| 长期记忆 | **✓ 6 层自动持久化** | session 级 | session 级 |
| 写作支持 | **✓ 词级 Diff 视图** | ✗ 只做代码 | ✗ 只做代码 |
| 中文优化 | **✓ 深度适配** | 一般 | 一般 |
| 零 Key 可用 | **✓ 内置 Brain** | ✗ 要订阅 | ✗ 要 Claude Key |
| 多 Agent + 人格 | **✓ Yuan 模板** | ✗ | ✗ |
| 微信/飞书 Bridge | **✓ 原生** | ✗ | ✗ |
| 开源协议 | **Apache 2.0** | 闭源商业 | 闭源商业 |
| 平台 | Mac + Win | Mac + Win + Linux | Mac + Win + Linux |

**Lynn 不替代 Cursor**——如果你正在编辑代码,Cursor/IDE 仍然合适。Lynn 接手的是更大的工作流:把多个 CLI Agent 派到不同 worktree,让它们修代码、写测试、查资料、改文档,然后在 GUI 里统一验收、跑门禁、合并和发布。

一个人可以同时拥有 IDE、单 CLI 和 Lynn 指挥台。V0.80 的目标就是让这些工具被编排起来,而不是互相替代。

---

## 本地模型,三档硬件分级

Lynn 本地模型按硬件分三档。V0.80 起本地 GGUF **不再随应用启动自动拉起**,避免一打开 Lynn 就占用约 6GB 显存/统一内存;需要本地离线推理时,在设置里显式启用即可:

| 档位 | 模型 | 体积 | 推荐硬件 | 上下文 | 能力信号 |
|------|------|:----:|---------|:------:|----------|
| **推荐本地** | **Qwen3.5-9B Q4_K_M imatrix MTP** | 5.38 GB | **24GB 显存/统一内存+** | 32K | **Q4_K_M imatrix** · MMLU 100 = 81.00% · GPQA Diamond 81.71% (excl. parse-fail) · 工具调用 14/15 · MTP 加速 |
| 降级 | Qwen3.5-4B Q4_K_M imatrix (Lynn) | 2.6 GB | 8~16GB 可选 | 32K | **Q4_K_M imatrix** · MMLU thinking-off 73.00% · GPQA thinking-off 16.67% · thinking-on 可能长思考后无正文 |
| 高端 · 编排器大脑 | **Qwen3.6-35B-A3B 蒸馏编排器** Q4_K_M imatrix | 21 GB | 24GB 显存/统一内存+ | 32K | **蒸 DS-V4-Pro thinking 思维方式** · MMLU 500 = 90.2% · GPQA-Diamond 80.3% · 端到端编排快 2.3× · Spark 77 / R6000 ~224 tok/s |

> 9B / 35B 质量数据均为 **Q4_K_M 量化态** + **thinking-on 32K max_tokens** 口径,GB10 Spark llama.cpp 同硬件实测。4B imatrix 作为低配降级:thinking-off 可用,thinking-on 已复现长思考后无正文,不作为默认引导模型。

| 通用 | 说明 |
|---|---|
| 运行方式 | llama.cpp 本地服务,OpenAI-compatible `/v1` 端点 |
| 隐私 | 可完全离线;不需要 API Key;对话不上传 |
| 默认 thinking | 自动策略:轻任务关闭 thinking;复杂任务可在 Lynn 输入框开启 |

### 下载与镜像

**推荐本地 9B** (显式启用):
- 🇨🇳 **ModelScope**: [Merkyor/Qwen3.5-9B-GGUF-imatrix](https://modelscope.cn/models/Merkyor/Qwen3.5-9B-GGUF-imatrix) (`Qwen3.5-9B-Q4_K_M-imatrix-mtp.gguf`,**5.38 GB**)
- 🤗 **Hugging Face**: [nerkyor/Qwen3.5-9B-GGUF-imatrix](https://huggingface.co/nerkyor/Qwen3.5-9B-GGUF-imatrix) / mirror `hf-mirror.com/nerkyor/Qwen3.5-9B-GGUF-imatrix`

**低配 4B / 高端 35B**(按硬件显式选择):
- 4B: [Merkyor/Qwen3.5-4B-GGUF-imatrix](https://modelscope.cn/models/Merkyor/Qwen3.5-4B-GGUF-imatrix) (`Qwen3.5-4B-Q4_K_M-imatrix.gguf`,**2.6 GB**) — 低配降级,建议 thinking-off
- 35B(编排器大脑): [Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill](https://modelscope.cn/models/Merkyor/Qwen3.6-35B-A3B-DSV4Pro-Thinking-Distill) (`gguf/Qwen3.6-35B-A3B-lynn-prod-Q4_K_M-imatrix.gguf`,**21 GB**) — **蒸馏任务编排器**(= 顶部「第一部分」的大脑),Spark 实测 77 / R6000 ~224 tok/s,24G 本地机可加载

应用内路径:**设置 → 模型 → 本地 Qwen3.5-9B → 授权安装并启用**。下载、校验、启动和模型注册都由 Lynn 后台完成;首次启用会提示本地模型暖机可能较慢,并说明会占用约 6GB 显存/统一内存。你可以随时在输入框旁看到本地模型状态,也可以停止以释放内存。模型页支持应用内切换 4B 降级 / 35B 高端档,或导入你自己下载的任意 llama.cpp 可用 GGUF。

---

## 开箱即用，零配置

首次启动有两条路径：

**Quick Start**（3 秒进主界面）— 输入名字、授权权限，直接开聊。**内置免费默认模型池**（Brain V2 主链头位 StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算),Spark 接本地/自建兜底）：

```
T1  ⭐ StepFun 3.7 Flash（256K 上下文,high reasoning,32K 推理/生成预算,高速文本/编码主路）
T2  Spark Qwen 3.6 35B A3B（本地/自建零成本兜底）
T3  DeepSeek V4-flash / V4-pro（云兜底，长上下文）
T4  智谱 GLM / Kimi / MiniMax（供应商备用链路）
```

多级降级自动切换：429、配额、供应商错误或能力不匹配 → 自动下一档，对话不中断。**默认模型有工具调用能力**（Plan C 透传，可以直接跑 `write` / `edit` / `read` / `bash`），不只是聊天。链式工具锚定、tool result reinforcement、tool-storm guard 和 pre-search 会在 router 层帮模型稳住多步工具结果。

**隐私三条承诺**：不训练、不落盘、日志最小化。想要绝对隐私？三种逃生路径：
- Lynn 本地 Qwen3.5-9B Q4_K_M imatrix MTP / 4B imatrix 低配降级 / 35B Q4_K_M imatrix(按硬件显式启用,本地离线使用且不消耗云端额度)
- 全程 Ollama 本地模型（无任何数据出门）
- 自备 OpenAI / Anthropic / Moonshot 等 API Key（走你自己的账号）
- 敏感工作区路径隔离（`.lynn/private/*` 不进记忆）

**Advanced Setup** — 想接自己的 provider？OpenAI 兼容协议全支持，7 家国产 Coding Plan（百炼/智谱/Kimi/MiniMax/阶跃/腾讯云/火山引擎）预注册，填 Key 即用。

界面支持 **5 种语言**：zh / en / ja / ko / zh-TW。

---

## 不是工具，是伙伴

Lynn 不是千篇一律的"AI 助手"。每个 Agent 有自己的名字、性格和说话方式，通过人格模板（Yuan）塑造——有的温柔细腻，有的理性冷静，有的活泼跳脱。

你可以创建多个 Agent，各自独立运行，**互相委派任务、频道群聊协作**。Agent 就是一个文件夹，备份和迁移都很简单。

连接 **Telegram / 飞书 / 企业微信 / QQ / 微信机器人** 后，同一个 Agent 可以同时在多个平台和你对话，甚至远程操作你的电脑。跨平台身份一致、不泄露底层模型（被问"你是 GPT 吗"会答"我是 Lynn"）。

---

## 不在的时候也在干活

这是 Lynn 与对话型 AI 工具最本质的区别。

**书桌（Desk）** 是你和 Agent 之间的异步协作空间。每个 Agent 都有自己的书桌，你可以放文件、写笺（Jian，类似便签）。写在笺上的待办事项，Agent 会主动读取并执行——你不需要开着对话窗口盯着它。

**心跳巡检（Heartbeat）** 会定期扫描书桌上的文件变化和笺的内容更新。发现新任务就自动处理，处理完了通知你。

**定时任务（Cron）** 让 Agent 按计划重复执行工作。每个 Agent 的 Cron 独立并发运行，切换 Agent 不会中断其他 Agent 的定时任务。笺里写的重复性待办会自动变成 Cron 任务。

**长任务稳定性** 是这套自主工作体系的基础。Lynn 的 server 以独立 Node.js 进程运行（不依赖 Electron 渲染进程），通过 WebSocket 全双工通信。对话中断、窗口关闭、网络波动都不会打断正在执行的任务。

---

## 国内模型深度优化

Lynn 不是简单套 OpenAI 兼容协议。从 9B 小模型到 GLM-5 推理模型，每一级都有针对性适配：

**工具分层（Tool Tiering）** — 按上下文窗口自动裁剪工具集：

| 档位 | 窗口 | 工具策略 |
|---|---|---|
| 小 | <32K（ERNIE / Step 8K 等） | 仅 `web_search` + `web_fetch` |
| 中 | 32K（豆包 / 混元 Pro / 百川 Turbo） | 标准 10 工具 |
| 大 | ≥64K（StepFun / Qwen3.6 / Kimi K2.6 / GLM-5 / DeepSeek V4） | 24 工具全开 |

**小模型专属 Prompt 工程** — context < 32K 时自动注入：回复限 500 字 + 关键结论 `<!-- KEY: -->` 标注（压缩时优先保留）；单工具串行调用规则（防弱模型并行错）；3 步以上任务强制先出计划等确认。

**自适应上下文压缩** — 小窗口保留 40% 近期上下文、4K 输出预留；大窗口 20% / 16K；压缩 1-2 次后自动 session 接力（大模型 3 次），防止质量崩溃。

**推理协议适配** — 智谱 GLM-5 系列走 ZAI thinking format（`thinking: { type: "enabled" }`）；Qwen3 全系走 `enable_thinking` quirk；两者走不同的 Pi SDK 补丁路径。

**工具调用容错** — 小模型工具调用连续失败 3 次后自动降级：停工具、用文字说明。空 `tools: []` 自动清理（dashscope / volcengine 不接受空数组会 400）。

---

## Harness 六层架构

Lynn 的核心 Agent 循环外面包裹了六层 harness，每层独立运作，通过共享的数据存储（FactStore SQLite、experience/、memory.md）协同：

```
用户输入
  │
  ├─ [1] Content Filter ── DFA 关键词过滤，17 类风险词库
  ├─ [2] Proactive Recall ─ 关键词 → FactStore FTS5 检索 → 隐形注入上下文
  │
  ▼
┌──────────────────┐
│  Core Agent Loop │  LLM 对话 + 工具调用（Pi SDK）
└──────────────────┘
  │
  ├─ [3] Tool Wrapper ──── 路径校验 + 命令 preflight + 危险操作授权
  ├─ [4] ClawAegis ─────── 工具返回内容的 Prompt Injection 扫描（纯正则，不调 LLM）
  │
  ├─ [5] Memory Ticker ─── 每 6 轮滚动摘要 → 每日深度 → 事实提取 → 技能蒸馏
  ├─ [6] Review System ─── 另一个 Agent 复查输出 → 结构化发现 → 自动修复任务
  │
  ▼
用户输出
```

**反馈闭环**：Review（第 6 层）用第二个 Agent 作"同事 code review"，发现问题自动构建修复任务回注执行链；Memory Ticker（第 5 层）从对话沉淀事实和经验到 FactStore；Proactive Recall（第 2 层）在下一次对话时把这些召回注入上下文。**评估 → 沉淀 → 召回 → 更好的执行 → 再评估**。

**低延迟、不阻断** 是每层的设计底色：Content Filter 用 DFA Trie；ClawAegis 扫描前 10KB 纯正则；Proactive Recall 正则 + SQLite；Memory Ticker 和 Review 都后台异步跑，不阻当前对话。

---

## 插件系统（7 类 contribution）

第三方想加功能**不用 fork 源码**。扔一个文件夹到 `~/.lynn/plugins/`：

```
my-plugin/
├── manifest.json       # 元数据
├── tools/*.js          # 自定义工具（注入 agent）
├── routes/*.js         # HTTP 路由（Hono）
├── commands/*.js       # 斜杠命令
├── skills/             # Skills 目录
├── agents/*.json       # Agent 模板
├── providers/*.js      # 自定义 LLM provider
├── hooks.json          # Lifecycle hooks（before-chat / after-tool 等）
└── index.js            # onload / onunload 生命周期
```

- **动态 import**（Node ESM 热加载，重启即见）
- **Hook 链**语义完整：`before-*` 返回 null 取消、对象替换、undefined 透传
- **disposables** 链：unloadPlugin 时按注册顺序 dispose，零泄漏
- 设置里的 PluginsTab UI 可视化管理

内置示例插件：`plugins/github-watch/`（定时扫 GitHub 仓库并通知）。

---

## 安全防护

Lynn 能读文件、跑命令、操作本地环境，所以安全不是附加功能，而是底座。**四层纵深防御**：

**第一层 · 路径守卫（PathGuard）** — 四级访问控制 `BLOCKED → READ_ONLY → READ_WRITE → FULL`。每次文件操作先 realpath 解析符号链接再匹配。SSH 私钥、`.env`、密码数据库等系统敏感文件硬编码 BLOCKED。工作目录以外默认只读。

**第二层 · 操作系统沙盒** — 终端命令不是直接执行：
- **macOS**：`sandbox-exec` 加载动态生成的 Seatbelt SBPL 策略
- **Linux**：Bubblewrap (`bwrap`) 命名空间隔离
- **Windows**：PathGuard 校验层（无 OS 级沙盒）

**第三层 · Prompt Injection 检测（ClawAegis）** — 外部文件内容的注入扫描：纯正则、零延迟、不调 LLM。覆盖"ignore previous instructions"、"pretend you are"、"read /etc/passwd"等攻击模式。检测到追加警告上下文，不阻断读取。

**第四层 · 行为确认与安全模式** — 三种模式：
- **安全模式**：只读，不写不跑命令
- **规划模式**：可读可写，危险操作暂停确认
- **执行模式**：完全授权，自主决策

危险操作（`rm -rf` / `sudo` / `git push --force`）始终弹确认框，不受模式影响。Skill 安装经独立 AI 安全审查（注入检测、过宽触发、权限提升），不过审则拒装。

---

## 自建 GPU 推理（可选进阶）

如果你有 GPU（或者能租到 vGPU），Lynn 支持把主力模型私有化。Brain 代理已经内置了 vLLM 适配：

- **推荐配置**：Qwen3.6-35B-A3B AWQ-4bit + vLLM + `--max-model-len 131072`（128K 窗口）
- **量化路径**：compressed-tensors + Marlin kernel + FP8 KV cache
- **工具调用**：OpenAI-compat 原生支持，Plan C 客户端工具透传无损
- **智能过滤**：118 个工具按用户意图自动过滤到 ~30 个（避免撑爆 GPU 上下文）
- **成本**：消费级 GPU ≈ 私有高级模型的日常体验，**实测 KV 容量 192K tokens**（单 64K 并发 ~3 路，平均 15K 场景 ~12 路）

搭配你的 OpenAI / Anthropic API Key 做降级兜底，就是**真正私有 + 有备援**的 Agent 基础设施。

---

## 工具能力速览

读写文件、执行终端命令、浏览网页、搜索互联网、截图、画布绘图、JavaScript 执行、Cron 调度、Agent 间通信、MCP 服务器……**24 个内置工具**覆盖日常办公绝大多数场景。

**33 个内置 Skills**：
- 写作：`novel-workshop`（小说工作台 v1.4 多 POV）、`humanizer`、`summarize`
- 研究：`deep-research`、`tavily-search`、`brave-search`、`baidu-search`
- 金融：`a-share-scanner`、`quant-scanner`、`stock-analysis`
- 前端：`canvas-design`、`frontend-design`、`image-lightbox`
- 效率：`notion`、`obsidian`、`nano-pdf`、`file-guardian`
- Agent：`agent-personality`、`proactive-agent`、`self-improving-agent`
- 自动化：`automation-workflows`、`blogwatcher`、`youtube-watcher`
- 生态：`github`、`weather`、`memory-recall` 等

Agent 也可以从 GitHub 安装技能或自己编写新技能，安装经独立 AI 安全审查。

---

## 截图

<p align="center">
  <img src=".github/assets/screenshot-main-20260407-v3.png" width="100%" alt="Lynn 主界面">
</p>

---

## 快速开始

### 下载安装

**macOS（Apple Silicon / Intel）**：从 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 下载最新 `.dmg`。V0.81.0 的 Apple Silicon / Intel DMG 会完成签名、公证、stapled,并通过 Gatekeeper 校验。

**Windows**：Windows 安装包以后续 [Releases](https://github.com/MerkyorLynn/Lynn/releases) 可见资产为准；当前 v0.81.0 在线更新 manifest 不会指向未上传的 Windows 安装包。

> **Windows SmartScreen 提示：** 后续 Windows 安装包会完成代码签名；首次运行仍可能因为新版应用声誉积累不足出现 SmartScreen 确认提示。

Linux 版本计划中。

### 首次运行

- **Quick Start**：输入名字 → 授权 → 进入主界面。默认模型池开箱即用，无需 API Key。
- **本地模型**：设置 → 模型 → 本地 Qwen3.5-9B。V0.80 起本地 9B 只在你明确点击启用后下载/启动;首次暖机会比云模型慢一些,但不会在打开应用时自动占用约 6GB 显存/统一内存。
- **Advanced Setup**：输入名字 → 连接自己的供应商 → 选对话/工具模型 → 设权限 → 进入。

所有模型配置后续都可在设置调整。

---

## 架构

```
core/           引擎层（LynnEngine Thin Facade + 10 个 Manager/Coordinator）
lib/            核心库
  ├── memory/     记忆系统（15 个文件，5000+ 行）
  │   ├── fact-store.js        SQLite + FTS5 + 关系图（765 行）
  │   ├── skill-distiller.js   自进化 Skill 提炼（599 行）
  │   ├── memory-ticker.js     每 6 轮滚动摘要（568 行）
  │   ├── vector-interface.js  向量检索（381 行）
  │   ├── proactive-recall.js  主动召回（287 行）
  │   └── retriever.js         标签 + FTS5 + 向量三路融合检索
  ├── tools/      24 个工具（浏览器、搜索、Cron、委派、技能安装等）
  ├── sandbox/    双层沙盒（PathGuard + macOS Seatbelt / Linux Bubblewrap）
  ├── bridge/     社交平台适配器（Telegram / 飞书 / QQ / 微信 / 企业微信）
  ├── desk/       书桌系统（心跳、Cron、笺运行时）
  └── ...         LLM 客户端、OAuth、频道存储、专家系统
shared/         跨层共享
server/         Hono HTTP + WebSocket（独立 Node.js 进程，24 个路由）
hub/            后台调度中枢（event bus、scheduler、channel router、DM 路由）
desktop/        Electron 38 + React 19 + Zustand 5
skills2set/     33 个内置技能定义
plugins/        内置插件（github-watch 等）
scripts/        构建工具（server 打包、启动器、签名）
tests/          Vitest 测试
```

**引擎层**：`LynnEngine` Thin Facade 持有 AgentManager、SessionCoordinator、ConfigCoordinator、ModelManager、PreferencesManager、SkillManager、ChannelManager、BridgeSessionManager、ExpertManager、PluginManager，对外统一 API。

**Hub**：独立于聊天会话运行，负责心跳巡检、Cron（per-agent 并发）、频道路由、Agent 间通信（含防无限循环硬上限 + 冷却期）、DM 路由。

**Server**：独立 Node.js 进程（由 Electron spawn 或独立启动），Vite + @vercel/nft 打包，WebSocket 全双工。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron 38 |
| 前端 | React 19 + Zustand 5 + CSS Modules |
| 构建 | Vite 7 |
| 服务端 | Hono + @hono/node-server + @hono/node-ws |
| Agent 运行时 | [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono) |
| 数据库 | better-sqlite3（WAL 模式 + FTS5 + 向量搜索） |
| 测试 | Vitest |
| 国际化 | 5 语言（zh / en / ja / ko / zh-TW） |

---

## 平台支持

| 平台 | 状态 |
|------|------|
| macOS (Apple Silicon) | 已支持（V0.81.0 签名 + 公证 DMG） |
| macOS (Intel) | 已支持 |
| Windows x64 | Beta |
| Linux | 计划中 |
| 移动端 (PWA) | 计划中 |

---

## 开发

```bash
npm install                   # 装依赖
npm start                     # Electron 启动（自动构建 renderer）
npm run start:vite            # Vite HMR 开发（需先 npm run dev:renderer）
npm test                      # 跑测试
npm run typecheck             # 类型检查
npm run build:server          # 打包 server
npm run dist:local            # 本地打包（macOS DMG，跳过公证）
```

---

## 许可证

[Apache License 2.0](LICENSE)

本项目基于 [liliMozi/openhanako](https://github.com/liliMozi/openhanako) 的开源工作，由 Merkyor 修改和扩展。核心 Agent 运行时使用 [@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono)（Apache 2.0 协议，Mario Zechner 出品）。详见 [NOTICE](NOTICE)。

---

## 常见问题 FAQ

### Q1：Lynn 免费吗？要交订阅费吗？

**完全免费，Apache 2.0 开源**。不卖订阅、不卖增强版、不 freemium。

后端 Brain 默认跑在作者自建服务器上（腾讯云 + 自建 GPU），**目前由作者承担成本供用户免费使用**。

### Q2：我的数据会被送到哪里？

**三条隐私承诺**：不训练、不落盘、日志最小化。

具体链路：
- **本地记忆**（facts.db / memory.md）：只在你电脑上，`~/.lynn/`
- **LLM 推理**：发送到 Brain → GPU / Kimi / GLM / DeepSeek。**作者不保存对话内容**，LLM 供应商按各自隐私条款处理
- **绝对隐私的三种姿势**：
  1. 全程 Ollama 本地模型（无任何数据出门）
  2. 自备 API Key（走你自己的 OpenAI / Anthropic 账号）
  3. 敏感工作区隔离（`.lynn/private/*` 不进记忆）

### Q3：和 Cursor / Claude Code / Trae 有什么区别？

看上面 [**和 Cursor / Claude Code 横比**](#和-cursor--claude-code-横比) 表格。

一句话：Cursor 系解决“正在写这段代码”的编辑器内流程;Claude Code / Codex CLI 解决“一个终端 Agent 干活”;Lynn 解决“多个代码/业务/研究任务如何被调度、验收和收口”。不冲突,可并存。

### Q4：没 API Key 能用吗？

**能**。Quick Start 60 秒进主界面直接聊，全程零配置。后台自动走 Brain v2 降级链（StepFun 3.7 Flash(256K 上下文,high 推理,32K 推理/生成预算) ⭐ → Spark Qwen3.6-35B A3B → DeepSeek V4 → GLM / Kimi / MiniMax），哪档有空走哪档。多模态输入以后端当前启用的多模态 provider 或用户 BYOK 端点为准。

### Q5：Windows 能用吗？

可以。后续 Windows 安装包会完成代码签名，但 SmartScreen 仍可能因为新版应用声誉积累不足而提示确认；当前 v0.81.0 已发布的是 macOS Apple Silicon / Intel DMG 和 CLI 包，macOS DMG 均已签名、公证并通过 Gatekeeper 校验。

### Q6：能改模型吗？接自己的 API？

可以。设置 → 模型 → 填 API Key（支持 OpenAI / Anthropic / DeepSeek / 智谱 / Kimi / MiniMax / 通义千问 / 百炼 / Ollama 本地 / 硅基流动 等所有 OpenAI-compat provider）。

**7 家国产 Coding Plan 预注册**，填 Key 即用：百炼 / 智谱 / Kimi / MiniMax / 阶跃 / 腾讯云 / 火山引擎。

### Q7：Lynn 能替代 ChatGPT 吗？

功能重叠但定位不同：

- **ChatGPT 桌面版**：无长期记忆、单一人格、无工作流工具
- **Lynn**：6 层记忆、多 Agent + 人格、写作 Diff、Cron 调度、多平台 Bridge

如果你只想**聊天 + 查资料**，ChatGPT 够用。
如果你想要一个**能记住你、能帮你处理文件、能异步干活**的 Agent，Lynn 更合适。

### Q8：怎么贡献代码？

- 提 Issue 说 bug / 建议：直接提
- 小 PR（文档 / typo / 小功能）：直接提
- 大改动（新模块 / 架构调整）：先开 Issue 讨论方案再 PR
- 见 [CONTRIBUTING.md](CONTRIBUTING.md)

### Q9：Lynn 名字的来源？

作者就叫 Lynn 😊

---

## 链接

- 📥 [下载最新版](https://github.com/MerkyorLynn/Lynn/releases)
- 🐞 [提交 Issue](https://github.com/MerkyorLynn/Lynn/issues)
- 🔒 [安全政策](SECURITY.md)
- 🤝 [贡献指南](CONTRIBUTING.md)
- 📖 [项目仓库](https://github.com/MerkyorLynn/Lynn)
