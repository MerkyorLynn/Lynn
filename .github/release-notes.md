# Lynn v0.87.4 · Windows 稳定性与增强 CLI

## 国内镜像站下载（推荐） / Downloads

国内用户请优先使用以下镜像下载；GitHub Assets 作为备用下载。

- [macOS Apple Silicon](https://download.merkyorlynn.com/downloads/Lynn-0.87.4-macOS-arm64.dmg?rev=20261028)
- [macOS Intel](https://download.merkyorlynn.com/downloads/Lynn-0.87.4-macOS-x64.dmg?rev=20261028)
- [Windows x64](https://download.merkyorlynn.com/downloads/Lynn-0.87.4-Windows-Setup.exe?rev=20261028)
- [下载说明页](https://download.merkyorlynn.com/download.html)

```bash
npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-0.87.4.tgz?rev=20261028"
Lynn --version
```

## 中文

- 修复 Codex 接入冷启动误判：协议预检等待时间对齐实际客户端的 30 秒，避免正常的超过 5 秒初始化被错误回退；快速响应速度门槛不变。
- **2026-10-28 同版本修复**：修复 Apple Silicon / 未检测到独立显卡时，进入本地 Qwen 模型详情会出现“providers 区域发生了异常”、无法安装的问题。补充真实安装包的 16GB / 24GB Mac、容量不足、未知显存和 Windows 多显卡回归。版本仍为 V0.87.4；此前下载的用户请重新下载安装修复包，同版本通常不会触发自动更新。

- 修复 #76：Windows 本地模型状态查询改用系统目录中的原生工具，并隐藏查询窗口；不再调用 PATH 中 Anaconda 等环境提供的 ps.exe，也不再向 Windows 工具传递 POSIX 参数。
- 实现 #77：汇率主源不可用时回退到 AllRatesToday，标明来源、更新时间和 ECB 每日参考汇率属性；支持黄金美元/人民币换算。备用源成功结果缓存一小时，并合并并发请求；无有效数据时明确报错。
- 合入增强 CLI：流式工具调用、并发只读工具、串行写入屏障、精确字符串编辑、任务内阅读去重、长命令后台执行、计划模式、技能与项目命令、会话分支、上下文压缩、长结果落盘及输入排队。
- CLI 权限规则支持 allow/ask/deny；仓库中的允许规则和 hook 需要明确建立信任。拒绝规则优先，配置损坏或守门 hook 失败时不继续执行，明确的 ask 规则不会被 yolo 模式跳过。
- 修复增强 CLI 的读取/写入竞态、断流后的残留工具调用、跨任务阅读缓存污染和仅停止父进程的问题。后台日志只读取有界尾部，安装脚本不改动其他程序的命令链接。
- CLI 网页抓取逐跳检查重定向，支持主动取消，并修正部分 IPv6 内网地址与普通域名的误判。
- 搜索结果明确区分发布时间与抓取时间；遇到实时数据和搜索新闻冲突时要求核验事件日期，避免把历史内容当作当日结果。
- 修复搜索资料误触发内容过滤：使用服务器保存的原始用户请求进行输入检查，同时保留检索资料供模型分析。
- 修复体育工具返回后对话提前结束：模型继续整理和解释真实赛程、比分；移除写死的预测比分。
- GUI / CLI 同步升级。默认模型仍为 Step 5 Preview，实时语音仍为 StepAudio 2.5 Realtime；保留 Coder390 llama.cpp Q2 / Q3、长推理超时设置和会话删除功能。

## English

- Align Codex protocol cold-start preflight with the client's bounded 30-second request timeout; preserve fast-response performance thresholds.
- **2026-10-28 hotfix, same version**: fix the local Qwen settings crash when Apple Silicon or a machine without detected dedicated GPUs returns an empty GPU list. Add packaged UI coverage for Mac memory tiers and Windows GPU detection. The version remains V0.87.4; users with the original package should download and reinstall the repaired build. Same-version updates generally do not trigger the updater.

- Fix #76: use hidden native Windows process/listener queries through absolute system paths instead of PATH-provided ps.exe or POSIX arguments.
- Implement #77: fall back to AllRatesToday for FX and gold currency conversion. Attribute its ECB daily reference rates and timestamps, cache successful tables for one hour, and report unavailable data explicitly.
- Integrate the enhanced CLI: streaming tool execution, concurrent reads with write barriers, exact-string edits, task-scoped read tracking, background jobs, plan mode, skills/project commands, session forks, compaction, result spilling and queued input.
- Enforce explicit permission rules and trusted hooks; fail closed on invalid policy or failed guards. Fix tool ordering, interrupted-stream dispatch, read-cache isolation, process-tree cancellation and installer shim ownership.
- Validate web redirects at each hop and propagate cancellation. GUI and CLI retain Step 5, realtime voice, Coder390 Q2/Q3, long-reasoning controls and conversation deletion.
- Distinguish publication dates from retrieval timestamps and require dated evidence when search reports conflict with live structured data.

- Check the original user request without mistaking retrieved page contents for user input; keep the retrieved evidence available to the model.
- Let the model finish its sports analysis after tool results arrive, and remove canned score predictions.

## 仓库 / Repositories

- [GitHub 主仓](https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.4)
- [GitHub 备份仓](https://github.com/LynnMerkyor/Lynn/releases/tag/v0.87.4)
- [Gitee](https://gitee.com/merkyor/Lynn/releases/tag/v0.87.4)
