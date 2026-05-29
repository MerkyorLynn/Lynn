# V0.81 — CLI 完整 Ink TUI(固定输入框 + 持久状态栏 + 扫光动画)

> 状态:**单独立项**(用户拍板"完整 Ink 那一步单独开")。本文是设计 + 协调地基,**不在 v0.80 的 `cli/**` i18n/渲染批次里实现**。
> Lane:`cli/**` 归 **Codex**。这一步会给 `@lynn/cli` 加 React + Ink 依赖、重写交互循环 —— 属 **foundational 改动**,必须 Codex 主导或三方(用户/Claude/Codex)对齐后开工,不能由单方甩巨型 diff。

## 1. 目标
把 `lynn` / `lynn code` 的交互体感拉到 **Codex CLI / Claude Code 同级**:
- **固定底部输入框**(alternate-screen / 持久 prompt,不随滚动跑掉)
- **持久状态栏**(model · cache% · ctx K/1M · tokens · mode · think)
- **扫光动画**(thinking 态的 shimmer sweep,替代当前横条 spinner)
- 流式答案、工具块、diff、审批 modal 都在 Ink 组件里重绘,无闪烁

这是我此前给的 **P3 的"最后 20%"**:P1+P2(行式)已拿到 ~80% 体感(见 §3),Ink 补的是"像个 app"的那层。

## 2. 为什么必须单独开(协调点)
1. **依赖地基变化**:`@lynn/cli` 当前是**零运行时依赖**纯 node 包(`package.json` deps 为空)。Ink 要引入 `ink` + `react`(+ 其依赖)→ esbuild 产物体积显著上升,zero-dep 卖点终结。**这是一次性产品决策**,需用户拍板。
2. **重写热路径**:当前交互是 `readline` + 自写 raw-mode reader(`cli/src/commands/code.ts` `readCodeLine`、`chat.ts` 的 rl 循环)。Ink 要把这套换成 React 组件树 + Ink 的 input 处理 → 和 Codex 正在迭代的 loop **高度重叠**,并行改必撞。
3. **非 TTY / CI 回退**:Ink 只在 TTY 工作。`--json`、管道、CI 必须保留现有行式路径。Ink 是 TTY-only 的增强层,不是替换。

## 3. 已就位的地基(v0.80 这批,Ink 直接复用)
这一步**不用从零开始** —— 下列零依赖纯模块已落地(`claude/v080-cli-ux` 7 commit + `claude/v080-cli-ux-i18n-tail`),都能直接喂进 Ink 组件:

| 模块 | 作用 | Ink 里怎么用 |
|---|---|---|
| `cli/src/markdown.ts` | 流式 markdown(`MarkdownStream` / `renderMarkdown`) | `<MessageList>` 渲染 assistant 文本 |
| `cli/src/diff-format.ts` | 彩色 patch(`colorizePatch` / `classifyPatchLine`) | `<DiffView>` / 审批 modal |
| `cli/src/history.ts` | 持久历史 + `HistoryNavigator` | `<InputBox>` 的 ↑/↓ |
| `cli/src/completion.ts` | slash Tab 补全(`completeSlash`) | `<InputBox>` 的 Tab |
| `cli/src/i18n.ts` | zh 默认 + `t()` | 所有组件文案 |
| `cli/src/startup.ts` `displayWidth` | CJK 终端列宽 | 状态栏 / box 对齐(Ink 的 measureElement 不算 CJK,需要它) |
| `cli/src/terminal-style.ts` | ANSI 颜色 + `supportsColor` | NO_COLOR 回退 |

**关键**:逻辑都在纯函数里,Ink 只是换"渲染外壳",不是重写逻辑。

## 4. 架构草案
```
<App>                      // 顶层,持有会话状态 + 路由
 ├─ <Transcript>          // 可滚动历史:user/assistant turns
 │   ├─ <Markdown>        // 复用 markdown.ts
 │   ├─ <ToolBlock>       // 工具调用 + 结果(复用 diff-format)
 │   └─ <ReasoningFold>   // 折叠 reasoning(· reasoning 1.8k tok · cached 84%)
 ├─ <ScanIndicator>       // 扫光动画(thinking 态)
 ├─ <StatusBar>           // 固定:model · cache% · ctx · tokens · mode · think
 └─ <InputBox>            // 固定底部:多行 + 历史 + 补全 + @ 提及
<ApprovalModal>           // 危险工具审批(y/n/a),复用 diff-format 预览
```
- **渲染策略**:Ink 的 `<Static>` 放已完成的 transcript(避免重绘整屏),活跃区(scan + status + input)用普通 Box 重绘。
- **流式**:assistant.delta 进 `MarkdownStream`,emit 的行 append 到当前 turn 的 state。

## 5. 扫光动画(扫光 / shimmer sweep)
当前是 `terminal-spinner.ts` 的横条滚动(`━`/`─`)。Ink 版升级为 **shimmer**:
- 一行文字(如 `Lynn 思考中…`)上,一束高亮(bold/亮色)从左到右扫过,身后渐暗(dim)。
- 实现:每帧按字符位置算到"光头"的距离 → 距离 0–1 亮、2–3 中、其余 dim;`pos` 随帧自增循环。**逻辑和现有 spinner 的 bar 算法同源**,换成作用在文字字符上 + 三档亮度。
- 帧率 ~12fps(80–90ms);`supportsColor=false` / `NO_COLOR` → 退回静态 `…` 省略号(无动画)。
- 窄终端 / CI → 禁用。

## 6. 迁移计划(分阶段,可回退)
- **Phase A**:Ink 脚手架 + `<InputBox>` + `<Transcript>`,跑通一个 turn;非 TTY 仍走现有 `runChat`/`runCodeInteractive`。
- **Phase B**:接 markdown 流式 + 工具块 + 审批 modal(复用纯模块)。
- **Phase C**:`<StatusBar>` + `<ScanIndicator>`(扫光)+ token/ctx 计量(从 usage 事件取)。
- **Phase D**:历史/补全/多行/@ 提及接入 `<InputBox>`;删旧 `readCodeLine` raw 路径(仅留非 TTY 行式)。
- 每阶段:`cli typecheck` 0 + 现有 105 测试不回归 + 新增组件测试(`ink-testing-library`)。

## 7. 风险 / 待决
- **依赖体积**:react+ink 打进 `bin/lynn.mjs` 后体积(需实测;若过大考虑 lazy-load 仅 TTY 时引入)。
- **Ink vs 自写 ANSI TUI**:Ink 省事但引 react;自写 alternate-screen TUI 可保零依赖但工作量大。**建议 Ink**(plan 原选型),但这是 §2.1 的产品决策点。
- **CJK 宽度**:Ink 布局默认按 string length,CJK 会错位 → 必须接 `displayWidth`(已就位)或 patch Ink 的 measure。
- **谁来写**:`cli/**` 是 Codex 的 lane → **Codex 主导**;Claude 可供组件/动画实现或 review;用户定依赖决策。

## 8. 验收
- 固定输入框在长输出滚动时不跑位;状态栏常驻且数字实时(ctx/tokens)。
- 扫光动画流畅、`NO_COLOR` 优雅退化、窄终端不破。
- `--json` / 管道 / CI 全程走行式路径,零 ANSI 污染(与现状一致)。
- 现有 105 测试 + 新组件测试全绿;典型会话 vs Codex CLI / Claude Code 做体感对照。

---
*关联:v0.80 CLI UX 已交付 P0(i18n+去乱)/ P1(markdown+diff+a=always+reasoning)/ P2(历史+补全)/ P3 行式状态栏 + B(全中文 i18n)+ 离线 REPL 修复。本文是 P3 的 Ink 完整版,独立推进。*
