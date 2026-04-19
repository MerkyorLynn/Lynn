# Lynn 0.76.2-beta 测试指南

**构建时间**：2026-04-18  
**分支**：`experiment/pi-sdk-067`  
**主要变化**：pi-sdk 0.56.3 → **0.67.68**（跨 11 个小版本）

---

## 🎯 核心升级收益

1. **Qwen chat-template thinking replay 修复**
   - 修上游：多轮对话时 Qwen3 系列 thinking context 保留
   - 影响你的 **T1 主力 Qwen3.6-35B-A3B**
2. **`after_provider_response` hook**（未来可用来简化 Brain adapter）
3. **session_shutdown** 支持 SIGHUP/SIGTERM 优雅退出
4. **claude-opus-4-7** 模型支持
5. **--no-context-files** 精确控制 AGENTS.md 注入

---

## 📦 当前安装状态

| 位置 | 版本 | 用途 |
|---|---|---|
| `/Applications/Lynn.app` | **0.76.2-beta.0** 🧪 | 正在测试 |
| `/Applications/Lynn-0.76.1-stable.app` | 0.76.1 | 应急回滚 |

双方共享 `~/Library/Application Support/lynn/` 用户数据，切换应用不丢数据。

---

## ✅ 已自动通过的检查

- [x] typecheck 0 error
- [x] `npm test` **680/680 通过**
- [x] **9/9 pi-sdk patches 全部适配** 0.67.68
  - 1 个重写（zai-thinking-format 因结构变化）
  - 8 个自动兼容
- [x] build:server / build:main / build:renderer 成功
- [x] electron-builder --dir + codesign 过
- [x] `fix-modules.cjs` 新增 scoped package (`@cypress/*`) + server 侧 symlink 清理

---

## 🧪 你需要**手动验证**的 12 项

### A. 基础启动（必测）
- [ ] 1. Lynn 能启动，主界面正常显示
- [ ] 2. 模型列表下拉正常（可以看到 Brain T1-T6 / 自配 provider）
- [ ] 3. 控制台无红色错误（`Cmd+Option+I` 打开 DevTools）

### B. Qwen3 thinking（**重点！新升级的核心收益**）
- [ ] 4. 切到 **Qwen3.6-35B-A3B**（T1），开启 thinking/reasoning 模式
- [ ] 5. 进行 **3 轮以上的连续对话**，每轮让它 think + 用工具
  - 示例：
    - 第 1 轮："帮我列出 Lynn 桌面端 6 层 memory 的文件"
    - 第 2 轮："现在把每个文件的行数统计出来"
    - 第 3 轮："按行数排序写成 markdown 表格"
- [ ] 6. 验证：**第 3 轮 thinking 内容是否保留了前两轮上下文**（这是 0.67 官方修的 bug）

### C. GLM 推理（验证 zai-thinking patch 重写正确）
- [ ] 7. 切到 **GLM-4.7** 或 **GLM-5.0-Turbo**，开启 thinking
- [ ] 8. 发一个需要推理的问题（数学题 / 逻辑题 / 代码题）
- [ ] 9. 验证：**返回内容非空**（如果 thinking patch 写错了，GLM 会返回空响应）

### D. 工具调用链（验证 Brain tolerant adapter 还在工作）
- [ ] 10. Brain 模式下让 AI **写/编辑一个文件**（write/edit 工具）
- [ ] 11. Brain 模式下让 AI **跑一个命令**（bash 工具）
- [ ] 12. 确认 diff 视图正常（`.md` 走 WritingDiffViewer，`.js` 走 DiffViewer）

### E. v0.76.1 叠加的新功能（跟着测）
- [ ] 13. TaskModePicker（左下角 ⚡ 芯片）可以打开 + 切模式
- [ ] 14. 社媒模式下点 `/xhs` 展开 prompt 模板
- [ ] 15. MCP section 可以 toggle 服务器激活
- [ ] 16. 写作模式（⇧⌘M）切换正常，聊天区加宽到 800px

### F. 记忆系统（验证 FTS5 没被破坏）
- [ ] 17. 打开一个有历史对话的 session
- [ ] 18. 跟 AI 说"你记得我之前说过 XX 吗"，验证能召回

---

## 🚨 如果遇到问题

### 快速回滚到 0.76.1 stable

```bash
# 1. 退出 beta
osascript -e 'tell application "Lynn" to quit'

# 2. 恢复 stable
rm -rf /Applications/Lynn.app
mv /Applications/Lynn-0.76.1-stable.app /Applications/Lynn.app

# 3. 重新打开
open /Applications/Lynn.app
```

### 代码层面回滚
```bash
cd /Users/lynn/Downloads/Lynn
git checkout main           # 回到 0.76.1 代码
# experiment/pi-sdk-067 分支保留，以后可以继续打磨
```

### 已知风险点（如果报错看这里）

| 症状 | 原因 | 排查 |
|---|---|---|
| GLM 返回空响应 | zai-thinking patch 写错 | `grep "0.67+" node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` |
| Brain 模式消息空消息 | Brain tolerant adapter 位置变了 | 查 `openai-completions.js` 有 `streamBrainTolerantOpenAICompletions` |
| 工具调用报 "Cannot read properties of undefined (reading 'totalTokens')" | compaction.js 兜底失效 | `grep "tolerate missing usage" node_modules/@mariozechner/pi-ai/dist/compaction.js` |
| dashscope/volcengine 400 | strip empty tools patch 失效 | `grep "strip empty tools" node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js` |
| Qwen thinking 没开启 | qwen-chat-template 识别错 | 检查 provider compat 配置 |

### 去查日志

```bash
# Lynn 渲染进程日志
# DevTools Console（Cmd+Option+I）

# Lynn server 日志
ls ~/Library/Application\ Support/lynn/logs/
tail -f ~/Library/Application\ Support/lynn/logs/*.log
```

---

## 📋 验证完成后

**如果 17 项全过 → 合并到 main：**

```bash
cd /Users/lynn/Downloads/Lynn
git checkout main
git merge experiment/pi-sdk-067
# 改 package.json 版本 0.76.2-beta.0 → 0.76.2
# 发 release
```

**如果有 1-2 项过不去 → 回滚单独修：**
- 在 `experiment/pi-sdk-067` 分支继续打补丁
- 修好后再发起合并

**如果核心（thinking / 工具调用）崩 → 回滚 + 等 0.68：**
- 从 stable 继续发 0.76.1 修复版
- 把这次 beta 的经验写进 `RETRO-pi-sdk-067-upgrade.md`
- 等 pi-coding-agent 发 0.68，再开第二轮尝试

---

## 🔧 这次构建用到的关键修复

### Patch 脚本更新：新增 "0.67+ zai-thinking" needle

`scripts/patch-pi-sdk.cjs` +20 行，加上对新结构的识别：

```js
const modernThinkingNeedle =
    '    if (compat.thinkingFormat === "zai" && model.reasoning) {\n' +
    '        params.enable_thinking = !!options?.reasoningEffort;\n' +
    '    }\n' +
    '    else if (compat.thinkingFormat === "qwen" && model.reasoning) {';
```

### 打包脚本更新：fix-modules.cjs

**3 个关键改进**：
1. 不再因为 `asar: true` 没有 `Resources/app/node_modules` 而早退
2. 递归进 scoped package（`@cypress/`, `@aws-sdk/` 等）找 `.bin`
3. 同时清理 server 侧（`Resources/server/node_modules/`）的 symlink

原 bug：`@cypress/request/node_modules/.bin/uuid` 是个绝对路径 symlink 指向 `/Users/lynn/Downloads/Lynn/dist-server/...`，codesign 拒绝签名。

---

## 📊 测试时间预估

- 基础启动：3 分钟
- Qwen thinking 验证：10 分钟（3-5 轮对话）
- GLM 推理验证：5 分钟
- 工具调用：5 分钟
- 其他新功能：10 分钟
- **总计：30-40 分钟**
