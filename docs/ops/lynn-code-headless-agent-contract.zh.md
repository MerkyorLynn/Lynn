# Lynn Code 无交互 Agent 调用契约

状态:v0.81.0 release-candidate contract。

这份文档给其他智能体、CI、GUI Fleet worker 阅读。目标是让它们无需和人交互,也能稳定调用 Lynn CLI 完成编码任务。

## 一句话

用 `Lynn code -p "<任务>" --json --cwd <worktree>` 启动无交互编码任务,从 stdout 读取 JSONL 事件;需要无人值守改文件时,在隔离 git worktree 里加 `--approval yolo --sandbox danger-full-access`。

## 最短可复制命令

```bash
# 1. 需要 Node.js 20 LTS 或 22 LTS
node -v

# 2. 安装或覆盖升级 Lynn CLI
npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.81.0.tgz

# 3. 检查本地命令
Lynn version
Lynn doctor --offline

# 4. 人类交互入口
Lynn
Lynn code
Lynn agents

# 5. 一次性问答,JSONL 输出,完成后退出
Lynn -p "总结这个仓库" --json --cwd /path/to/repo

# 6. 无交互编码 Agent。只在隔离 worktree 里使用 yolo。
Lynn code -p "修复失败测试,运行测试,总结 diff" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# 7. 穷尽最优任务。会保存断点,达到步数上限时可 resume。
Lynn code --best -p "找出最优方案,实现并跑门禁" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session

# 8. GUI Fleet worker adapter。输出 Fleet JSONL,不是人类文本。
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

## 其他智能体必须遵守的规则

- 机器调用必须使用 `--json` 或 `--jsonl`,不要解析人类 TUI。
- 必须显式传 `--cwd` 或 `--worktree`。
- `--approval yolo --sandbox danger-full-access` 只用于隔离 git worktree。
- 看到未知 JSONL event type 时应忽略,按 `type` 字段分发。
- `code.tool.ledger` 是链式工具结果的压缩事实源。
- 长任务必须加 `--save-session`;如果 `code.task.finished` 里有 `resumeCommand`,应继续调用它。
- `worker.violation` 或不可恢复的 `worker.error` 是硬失败。

## 穷尽最优模式

需要“最好结果”而不是“最快收口”时,使用 `--best` 或 `--exhaustive`:

```bash
Lynn code --best -p "找出最优方案,实现并跑门禁" \
  --json \
  --cwd /path/to/worktree \
  --approval yolo \
  --sandbox danger-full-access \
  --save-session
```

`--best` 会保持 StepFun 3.7 Flash 作为高速主路由,并启用 300 步预算、ultra 任务分解、原子 worker、对抗式验收、自动验证、checkpoint/resume 和运行时压缩。Harness 只做拆步、分派、验证、修复和防工具风暴,不会用路由兜底替模型选择最终答案。

## 权限模式

| 场景 | 推荐参数 |
| --- | --- |
| 只读审查 | `--approval ask --sandbox read-only` |
| 人类交互改代码 | `--approval ask --sandbox workspace-write` |
| Fleet/CI 无人值守 | `--approval yolo --sandbox danger-full-access` |
| 本机可信调试 | `--approval yolo --sandbox danger-full-access` |

ask 模式会弹授权卡片。yolo 模式不会逐条询问,适合黑灯工厂,但必须由外层 worktree / Fleet gate 承担隔离和验收。

## 输出事件

Lynn 无交互输出是 JSONL,每行一个 JSON 对象。常见事件:

| 事件 | 含义 |
| --- | --- |
| `code.task.started` | 接受任务并收集仓库上下文 |
| `assistant.delta` | 模型回答增量或最终文本 |
| `reasoning.delta` | 推理文本;可能是 hidden |
| `code.tool.requested` | 模型请求本地工具 |
| `code.tool.result` | 本地工具完成 |
| `code.tool.ledger` | 链式工具结果摘要 |
| `code.runtime.compacted` | 旧轮上下文已压缩,目标/计划/近期工具结果保留 |
| `code.auto.verify` | 自动验证结果 |
| `session.checkpoint` | 写入可恢复断点 |
| `session.saved` | 最终会话路径 |
| `code.task.finished` | 任务结束,包含 ok / resumeCommand 等字段 |

## 模型与长任务稳定性

默认路由为 StepFun 3.7 Flash -> Spark Qwen 3.6 35B A3B。Lynn Code 会保持稳定前缀层,让前置缓存更容易命中;长任务过程中会自动压缩旧轮上下文,并保留原始目标、当前计划和最近工具结果。

本地工具链还包含:

- 自动验证收尾门:改完代码后自动跑可检测的 typecheck/test。
- 计划契约:计划未完成时不轻易收尾。
- 工具预算/风暴抑制:重复工具调用会被压制并回喂模型。
- 快照/断点:长任务可 resume,崩溃后会修复中断工具帧。

## 作为 Fleet worker

```bash
Lynn worker run --brief task.md --worktree /path/to/worktree \
  --jsonl \
  --approval yolo \
  --sandbox danger-full-access
```

Fleet 只信 Lynn 侧门禁:ownership、forbidden globs、测试结果、最终 diff。外部 CLI 的 `--yolo` 或 `--dangerously-*` 只是不让 worker 卡在交互审批,不代表可以绕过 Lynn 的合并 gate。

## 健康检查

```bash
Lynn version
Lynn doctor --offline
Lynn -p "只回复 OK" --json
Lynn agents --json
```
