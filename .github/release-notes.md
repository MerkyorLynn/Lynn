# Lynn v0.78.0 Release Notes

> 发布日期: 2026-05-12 · 代号: "Windows Startup Hotfix"

v0.78.0 是一个稳定性热修版本，重点修复 Windows 用户从旧版升级后启动失败的 SQLite schema migration 问题，同时把新用户默认模型链路切到 Brain v2；已有用户的 Brain v1 配置会继续保留，不会被桌面端升级强制覆盖。

## 重点更新

### Windows 启动修复
- 修复旧 `facts.db` 升级时可能在启动阶段报 `SQLITE_ERROR: no such column: category` 的问题。
- 调整 FactStore schema 初始化顺序：先完成迁移，再创建依赖新列的索引。
- 对旧库缺失 `category / confidence / evidence` 字段的场景补充回归测试，覆盖真实 crash.log 路径。

### Brain v2 默认策略
- 新安装用户默认走 Brain v2 模型链路。
- 已经存在 `brain` provider 或本地 prefs 的老用户继续使用原有配置，避免稳定 v1 用户被一刀切迁移。
- Onboarding、Provider 默认配置和运行时 seed 统一使用新的 V2 默认值。

### 数据安全
- 本次修复不删除、不重建用户数据库；旧记忆会通过迁移保留。
- 覆盖安装即可修复启动失败，无需用户手动删除本地数据。

## 回归结果

- Full test suite: `165 files / 1423 passed / 1 skipped`
- Brain provider policy tests: `6 passed`
- FactStore migration tests: `5 passed`
- TypeScript / build / release smoke: 见本次发版门禁记录

## 下载

- macOS Apple Silicon: `Lynn-0.78.0-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.78.0-macOS-Intel.dmg`
- Windows x64: `Lynn-0.78.0-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.78.0

## 升级建议

建议 Windows 用户尽快升级。遇到 0.77.10 / 0.77.11 启动失败的用户，直接覆盖安装 v0.78.0 即可，正常情况下不会丢失会话或本地记忆。
