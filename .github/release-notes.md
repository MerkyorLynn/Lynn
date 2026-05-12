# Lynn v0.78.1 Release Notes

> 发布日期: 2026-05-12 · 代号: "Deep Research Search Hotfix"

v0.78.1 是一个 Deep Research 热修版本,重点修复中文财经/热点调研在 DuckDuckGo HTML 返回 no-results 时直接失败的问题,并优化长耗时 Deep Research 的前端超时体验。

## 重点更新

### 中文财经搜索兜底
- DuckDuckGo HTML 搜索无结果时,会自动对中文财经长查询做简化重试。
- 新增 Bing HTML fallback,覆盖中文热点、融资、A 股影响等 DuckDuckGo 偶发空结果场景。
- 修复“可灵融资 20 亿对 A 股影响”这类问题容易返回 `DuckDuckGo HTML returned no results` 的情况。

### Deep Research 体验
- Deep Research 请求等待窗口与后端任务超时对齐,避免前端先报 `AbortSignal.timeout`。
- 超时/失败提示统一转成可读中文文案,用户能看到明确的重试建议。
- Deep Research 面板与结果格式化逻辑抽离,后续调研卡片可以更安全地迭代。

### 回归测试
- 新增中文财经搜索 fallback 回归测试。
- 新增 Deep Research timeout 与面板行为测试。
- 保留 v0.78.0 的 Windows SQLite migration / Brain v2 默认策略修复。

## 回归结果

- Full test suite: `165 files / 1427 passed / 1 skipped`
- Targeted search / stock / Brain / FactStore tests: passed
- TypeScript / server build / main build / renderer build: passed
- Release regression: static refs, manifest, smoke and UI gates passed

## 下载

- macOS Apple Silicon: `Lynn-0.78.1-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.78.1-macOS-Intel.dmg`
- Windows x64: `Lynn-0.78.1-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.78.1

## 升级建议

建议所有使用 Deep Research / 财经调研 / 搜索工具的用户升级。Windows 用户如果仍在 0.77.10 / 0.77.11,也可以直接覆盖安装 v0.78.1,会同时获得 v0.78.0 的 SQLite 启动修复。
