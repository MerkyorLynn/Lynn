# Brain 巡检执行记录

## 2026-04-20 00:42 CST — OpenClaw & Brain API 专项巡检

### 巡检结果摘要
- **Brain API**: 在线，端口 8789 正常，健康检查通过；**⚠️ 重启 188 次（异常高）**，当前仅运行 30 分钟，需排查频繁崩溃原因
- **OpenClaw**: 运行稳定，PID 68217，端口 18789/18791/18792 正常，99 个方法可用，已持续运行 6 天
- **系统资源**: 内存正常(2.4/7.5GB)，磁盘 55% 使用率，CPU 负载低
- **Nginx**: 实际运行中但非 systemd 管理；SSL 证书 merkyorlynn(78天) 和 download(79天) 即将到期
- **日志警告**: `Qwen3.6-35B-A3B tool_skip`、`missing signed headers` — GPU 工作站连接不稳定

### 待处理事项
1. 🔴 排查 Brain API 频繁崩溃原因（188次重启）
2. 🟡 设置 SSL 证书自动续期（merkyorlynn / download 域名）
3. 🟡 将 Nginx 纳入 systemd 管理

---

## 2026-04-11 10:02 CST — 飞书推送修复
- **问题**: health-check.py 未被 crontab 调度，飞书巡检推送被删
- **修复**: 添加 crontab 条目：`0 8,12,20 * * *` 执行 health-check.py（一日三次 8:00/12:00/20:00）
- **同时添加**: github-daily.py 每天 9:00 执行
- **验证**: 手动执行 health-check.py 成功推送飞书，Kimi-K2.5 已在巡检脚本中
- **巡检结果**: DS-Chat/MiniMax/GLM-4-Flash/GLM-5-Turbo/Step-3.5/SF-GLM-4-9B/SF-Qwen3-8B/SF-DS-V3.2/Kimi-K2.5/DS-Reasoner/GLM-5.1 正常；SF Z1-9B/Step-Vision/SF Qwen3-VL/Claude-4.6 超时

## 2026-04-11 08:02 CST
- **结果**: 7/10 模型正常，3 个异常
- **关键问题**: 智谱余额不足(GLM-4-Flash/GLM-4V-Plus 429)，Qwen3-VL-8B 模型名错误(400)
- **SiliconFlow余额**: ¥9.87 (赠送已耗尽)
- **Brain Node**: online, 83MB, PM2重启153次(偏高)
- **Nginx**: 运行中但非systemd管理，SSL自签名(至2036年)
