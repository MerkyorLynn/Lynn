# Lynn 原生(无 MCP)能力架构 — CLI · GUI · Brain

> 把 GenericAgent 启发的能力(工作便签 / web / 技能结晶)以**原生 TS、进程内、零外部 server** 的方式吸收进 Lynn。
> 决策:**稳定性 > 便利性**。不走 MCP、不走 Python sidecar。每个能力都**有界 + opt-in**。

---

## 0. 一条原则

```
凡能用一段进程内 TS 完成的,就不引入第二个进程/语言/协议。
每个借来的能力 = 重写成原生、加上界(token/超时/字节)、默认 opt-in。
```

为什么不是 MCP(Codex 已移除):

| | 原生 TS(本架构) | MCP / sidecar |
|---|---|---|
| 进程 | 进程内,零边界 | 独立 server,要拉起/重连 |
| Python | 无 | 接 GA 则要在 Electron 里打包 Python 运行时 |
| token | schema 同价 + **结果强制封顶** | 工具结果常失控膨胀 |
| 稳定性 | 确定性,headless/cron 也活 | 崩 / hang / 鉴权失效 / 版本漂移 |
| 分发 | 一个二进制 | 多进程 + 依赖树 |

---

## 1. 三个家(每个能力住哪)

```
                       ┌────────────────────────────────────────────┐
                       │                 BRAIN(共享)                │
                       │   6 层记忆 · Skill Distiller · 路由/模型     │
                       │   → 技能结晶住这里,CLI 和 GUI 共吃          │
                       └───────────────────┬────────────────────────┘
                          WS chat / stream │ (模型 token 从这来)
              ┌───────────────────────────┼───────────────────────────┐
              ▼                                                         ▼
   ┌───────────────────────────────┐               ┌───────────────────────────────────┐
   │          Lynn CLI             │               │       Lynn GUI(Electron)          │
   │     code-agent-loop.ts        │               │       本身就是 Chromium            │
   │   工具在用户机本地执行         │               │                                   │
   │                               │               │   原生能力(无需 Tampermonkey):   │
   │   原生工具:                   │               │   · BrowserView → web_scan        │
   │   · working_checkpoint  ✅    │               │   · BrowserView → web_execute_js  │
   │     (meta,逐步注入)          │               │     (真登录态,比 GA 的桥干净)    │
   │   · web_scan(Node fetch)→    │               │   · 承载 ultra / checkpoint / 结晶 │
   │   · ultra(分解+fan-out)✅    │               │     的可视化                       │
   └───────────────────────────────┘               └───────────────────────────────────┘
        本地、只读 web、确定性                          原生浏览器、可登录、可视
```

**关键非对称:** GUI 因为是 Electron,**自带一个真 Chromium**。GA 要靠 Tampermonkey + WebSocket 桥才能钻进真浏览器;Lynn GUI 直接开 `BrowserView` 就有 DOM、能注 JS、能保留登录态——**结构上比 GA 干净一层**。CLI 没浏览器,所以走 Node `fetch` + 零依赖简化(只读、安全)。

---

## 2. 能力地图(归属 / 机制 / 风险 / 状态)

| 能力 | 家 | 机制 | 风险 | 状态 |
|---|---|---|---|---|
| **ultra**(任务分解+并行+对抗综合) | CLI(GUI 承载) | `code-ultra.ts` 纯编排 + 原子 worker | 中(并发成本) | ✅ 已建、已并 |
| **working_checkpoint** | CLI loop(后续 brain) | meta 工具,state + 逐步 pin,4000 封顶 | 低 | ✅ 已建、Step3.7 实测 |
| **web_scan**(只读抓取) | CLI=Node fetch / GUI=BrowserView | fetch + 零依赖简化 + SSRF 防护 | 低 | 🔨 进行中 |
| **技能结晶**(成功→SOP→召回) | **Brain**(共享) | 成功轨迹蒸馏进 Skill Distiller | 低 | ⬜ next |
| **web_execute_js**(驱动登录浏览器) | **GUI** only | Electron BrowserView + approval | 高(风控/账号) | ⬜ 后置,门控 |

> L0-L4 分层记忆**不照搬**——Lynn brain 的 6 层比它细,借纪律不借实现。

---

## 3. 两种原生工具的接线模式(CLI 内)

CLI 的 agent loop 里,工具分两类,接法不同:

```
模型一轮产出工具调用
        │
        ├─ ① META 工具(update_plan / update_working_checkpoint)
        │     └─ 在 loop 内**拦截**,不进 registry、不碰文件/网络
        │        · isMetaTool() 统一豁免:不计 tool 预算、不触发 storm、不渲染
        │        · checkpoint:写 state → 每步 pin 进 turnMessages(扛 compaction)
        │
        └─ ② I/O 工具(read/write/bash/grep/glob / web_scan)
              └─ 走 runClientTool → tools/<x>.ts handler → 真动作
                 · web_scan:validateWebUrl(SSRF) → fetch(超时+字节上限) → simplifyHtml(封顶)
```

**opt-in 门控(统一模式):**
```ts
// codeToolDefinitions() 里
if (featureEnabled(process.env)) tools.push(<tool def>);
// 工具只有开了才进模型的 tools 数组 → 默认零影响、零 token
```
- `LYNN_CLI_WORKING_CHECKPOINT=1`
- `LYNN_CLI_WEB_SCAN=1`

**逐步注入点(checkpoint 的核心技巧):**
```
每步调用模型前:
  turnMessages = messages + (workingCheckpoint ? [pinned frame] : [])
  ↑ 从 state 重新派生,不写进持久 messages
  ↑ 即使历史被 compaction 砍掉,下一步又贴回来 → 天然抗压缩
```

---

## 4. web_scan:同一个工具,两个后端

```
                         web_scan(只读)
            ┌──────────────────────┴───────────────────────┐
        CLI(无浏览器)                              GUI(Electron)
   Node fetch(http/https)                    隐藏 BrowserView 真标签页
   零依赖 simplifyHtml:                       注入 optHTML(GA 的 JS 直接搬):
     去 script/style/head/注释                  去隐藏/浮层/被遮挡元素
     块标签转行、抽 title、折叠、封顶            保留输入值、可登录态
   SSRF 防护:屏蔽 localhost/私网/元数据IP       approval 门控(动作可见)
            └──────────────────────┬───────────────────────┘
                     给模型的都是"省 token 的简化文本"
```
- **CLI 版** = 读公开文档/API 参考,安全、确定性,适合编码。
- **GUI 版** = 真浏览器、可登录,适合 computer-use;**风险高 → 后置 + 门控**。
- GA 那段 `optHTML` 是 JS,**搬进 GUI 的 BrowserView 几乎零改**;CLI 用静态 HTML 的零依赖等价物。

---

## 5. 构建顺序与现状

```
✅ ultra(CLI)              已并主线
✅ working_checkpoint(CLI) 原生、10 测试、Step3.7 实测 3 次调用
🔨 web_scan(CLI)           零依赖 fetch+简化+SSRF,进行中
⬜ 技能结晶(Brain)         接 ultra:成功分解→SOP→召回
⬜ GUI 吸收                 BrowserView web + 承载 checkpoint/ultra/结晶
⬜ CLI+GUI 新版本           门禁绿 → 版本号 → PRE-FLIGHT 发布
```

**分支策略:** 原生能力堆在 `claude/native-*` 分支,与 Codex 主线解耦,验完再并(PR 不急)。

---

## 6. 待确认的一个接缝(诚实标注)

- CLI 工具**在用户机本地执行**(read/write/bash 跑在 CLI 进程)。
- GUI 的工具执行落点(brain 侧 vs Electron 本地)需确认:
  - **web**(scan/execute_js)→ 明确走 **Electron 本地 BrowserView**(要真浏览器)。
  - **checkpoint / 结晶** → 若 GUI 的 agent 循环在 brain,则需在 **brain 的 loop** 里也实现一份(CLI 的 `code-agent-loop.ts` 与 brain loop 是两套)。这是 GUI 吸收的主要工作量,非 CLI 的简单复制。
