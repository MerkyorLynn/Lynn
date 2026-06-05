# Lynn GUI v0.80.2 Release Notes / 发布说明

> 发布日期: 2026-06-05 · GUI search route cleanup and MiMo Token Plan removal

v0.80.2 refreshes the macOS desktop app while keeping the Lynn CLI release line
unchanged. This build removes the expired Xiaomi MiMo Token Plan LLM provider and
keeps the separate paid Xiaomi MiMo platform web-search API available as a
server-side search source for StepFun.

## 中文重点

- **移除过期 MiMo Token Plan LLM 路径**:桌面端、CLI 配置入口、Brain provider
  registry 和文档入口不再把过期的 Xiaomi MiMo Token Plan 当作可选 LLM 路由。
- **保留 MiMo 平台搜索**:`api.xiaomimimo.com` 的独立付费 web-search API 仍作为
  Brain 聚合搜索源,StepFun pre-search 会优先尝试 MiMo 搜索,再由其他搜索源兜底。
- **能力边界更清楚**:过期 LLM provider 与仍可用的付费搜索平台分离,避免用户误以为
  MiMo LLM 额度还能继续使用。
- **回归门禁覆盖**:Brain critical、Brain v2 mirror、runtime/server typecheck、
  desktop/fleet affected tests、完整 root test suite、server/main/renderer build 已通过。

## English Summary

v0.80.2 updates the macOS desktop app to remove the expired Xiaomi MiMo Token Plan
LLM route while preserving the separate paid Xiaomi MiMo platform web-search API
as a server-side Brain search source. The StepFun-first routing path remains the
default, and MiMo search is used only through the configured server-side
`MIMO_SEARCH_KEY`.

## Verification

- `npm run test:brain-v2:critical`
- `npm --prefix brain-v2-mirror test`
- `npm run typecheck`
- `npm run typecheck:runtime`
- affected desktop/fleet tests
- full `npm test`
- `npm run build:server && npm run build:main && npm run build:renderer`
