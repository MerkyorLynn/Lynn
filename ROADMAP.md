# Lynn Roadmap

## Completed

### V0.76.x — 稳定化 & 流式修复 (shipped)
- WritingDiffViewer: 词级高亮 + 段落 LCS 对齐
- WritingPreviewPanel: 右侧预览 + Cmd+Shift+W
- NovelWorkshop v1.2: 多视角叙事 (POV mode)
- Brain 废弃代码清理 (-30MB)
- 搜索中文翻译质量
- BYOK-equality thin-pipe + LLM Triage v1
- CROSS-PROMPT FENCE v1, TOOL-FAILED-FALLBACK v1.1, PIPE-NUMBERED-PSEUDO v1
- V8 benchmark: 34/34 通过, WeChat/飞书 实测干净

### V0.77 — LLM 核心迁移到 DGX Spark ✅
- SGLang + Qwen3.6-35B-A3B-FP8 + MTP (60-70 tok/s, accept 77%)
- DGX 稳定性 workaround (EEE off + earlyoom + swapoff)
- 三级 fallback: Spark → 4090 IQ4_XS → chatOrder
- D wrapper 双层 (5min cooldown + 30s health probe)

### V0.78 — 中文语音 ✅
- SenseVoice ASR + CosyVoice TTS Phase 1 打通
- KIMI Provider Registry 框架
- B 模式长按锁定

---

## In Progress (当前版本)

### V0.79 — 生图能力
- ComfyUI + CogView4-6B (中文 prompt, ~22GB)
- 80 行 FastAPI shim → OpenAI Image API
- 串行 GPU 调度 + TTS "正在画" 掩盖延迟

---

## Planned (逐版本上线, 一次只做一个)

### V0.80 — 地图/出行
- 高德 MCP (`@amap/amap-maps-mcp-server`, 12 tools)
- maps-bridge 抽象层 (provider: Amap → 备 Tencent → Google)
- 场景: 路径规划 / POI 周边 / 天气 / IP 定位
- 不占用 Spark 显存 (纯云 API)

### V0.81 — 办公协同
- 飞书官方 MCP (文档/日历/任务/IM)
- 腾讯文档 (社区 MCP, 质量不够就跳过)
- 写操作默认 draft + 用户确认

### V0.82 — 邮件
- IMAP/SMTP MCP (nodemailer + imapflow ~200 行)
- 默认 dry-run, 发邮件需用户确认
- 绝对不用主密码 (应用专用密码)

### V0.83 — 财经数据
- akshare MCP (A 股/期货/基金/外汇)
- 缓存 60s 防打爆数据源
- 不用于交易决策 (15min 延迟)

---

## Future Candidates (V0.84+, 待排优先级)

1. **工作区文件防丢失** — tool-wrapper.js `preflightCommand()` 自动快照 (hardlink 去重), 每日清理
2. **跨渠道共享时间线** — Bridge 消息路由到 focus session, 一个 Agent 一个 session 多个入口
3. **局域网访问** — `0.0.0.0` 监听 + mDNS + 移动端 Web UI + serverToken 认证
4. **ComfyUI / 图片生成集成** — 本地 ComfyUI 检测 + 云端 fallback (SiliconFlow)
5. **图片放大查看** — ImageBlock lightbox 组件 (纯 CSS + React), 缩放/拖拽/下载
6. **Linux 支持** — AppImage + deb, Bubblewrap 沙盒, `libappindicator` 检测

### 优先级原则
- 一次只做一个 milestone, 稳定再下一步
- 官方 MCP 优先 (节省维护成本)
- 写操作默认 draft + 用户确认
- 新能力全部通过 MCP 集成, 不侵入核心架构
- V0.79 之后所有新能力不占 Spark 显存 (云 API / 数据查询)
