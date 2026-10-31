# Lynn v0.87.5 · CLI 命令选择与桌面稳定性

[国内下载说明页](https://download.merkyorlynn.com/download.html)

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.5-macOS-arm64.dmg)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.5-macOS-x64.dmg)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.5-Windows-Setup.exe)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.5.tgz"
Lynn --version
```

### V0.87.5 重点更新

- **CLI 命令菜单可选择**：输入 `/` 后用 ↑↓ 移动，Tab / Enter 填入选中命令；支持滚动与键盘操作。
- **设置草稿更可靠**：按 Agent 保留未保存内容，切换设置页、刷新模型配置时保留草稿与经验列表。
- **会话执行更稳定**：修复并发工具结果匹配、桥接会话排队、上下文压缩和回复显示问题。
- **本地模型启动可恢复**：启动超时明确报错，允许手动重试，旧进程退出不会覆盖新进程状态。
- **文件与界面操作更稳妥**：修复文件访问和预览边界，为删除、撤回与高风险操作补充确认；完善菜单和设置控件键盘操作。
- **GUI / CLI 同步更新**：升级桌面与内置运行时依赖，延续 Step 5、实时语音及 Coder390 Q2 / Q3。

### V0.87.5 Highlights

- **Selectable CLI commands:** use Up/Down after `/`, then Tab or Enter to fill the selected command, with scrolling and keyboard navigation.
- **Preserved settings drafts:** retain per-agent unsaved changes and experience lists across settings navigation and model configuration refreshes.
- **More reliable sessions:** fix concurrent tool-result matching, bridge session queues, context compaction and reply rendering.
- **Recoverable local startup:** show startup timeouts, support manual retry and ignore stale process exit events.
- **File and interface fixes:** strengthen file/preview boundaries, confirm destructive actions and improve keyboard access to menus and settings.
- **GUI and CLI updated together:** refresh desktop and bundled runtime dependencies while retaining Step 5, realtime voice and Coder390 Q2/Q3.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.5)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.5)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.5)
