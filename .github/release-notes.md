# Lynn v0.77.1 Release Notes

> 发布日期: 2026-04-29 · 代号: "Guarded Hands"

v0.77.1 是一次围绕真实 dogfood 反馈的稳定性修复版:重点修工具执行、危险操作授权、伪工具泄漏、空答兜底和本地文件任务反馈,让 Lynn 在执行模式下更像一个可靠助手,而不是只会解释步骤。

## 重点更新

- 危险操作授权卡回归:执行模式下涉及删除、sudo、批量移动、覆盖等高风险命令会弹出授权卡确认。
- 授权卡 UI 改为 Lynn 米色风格,避免之前 Codex 深色卡片和整体界面割裂。
- 修复伪工具文本泄漏:模型输出 `<web_search>` / `<bash>` 这类假工具标签时会被识别并兜底处理,不再直接展示给用户。
- 强化工具成功后的最终反馈:文件整理、删除、移动等任务执行后必须给用户可见结果,避免"命令跑了但没回复"。
- 修复工具失败和空答兜底:工具失败、模型只输出开场白、或 retry 后仍无正文时,会给出明确可恢复提示。
- 本地文件任务更稳:优化下载/桌面目录别名、zip/excel/pdf 等文件识别和安全删除路径。
- 流式状态清理增强:降低跨轮污染、"Lynn 还在说话"、上一题工具结果串到下一题的概率。
- Release regression gate 保持在线,覆盖工具调用、文件操作、伪工具泄漏、thinking 泄漏和 UI smoke。

## 回归结果

- Unit/Integration: 826/826 pass
- TypeScript: 0 errors
- Static Release Smoke: pass
- Security/guard tests: pass

## 下载

- macOS Apple Silicon: `Lynn-0.77.1-macOS-Apple-Silicon.dmg`
- macOS Intel: `Lynn-0.77.1-macOS-Intel.dmg`
- Windows x64: `Lynn-0.77.1-Windows-Setup.exe`
- 镜像站: https://download.merkyorlynn.com/download
- GitHub: https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.1

## 升级建议

桌面客户端可以直接安装覆盖。v0.77.1 没有破坏性配置迁移;如果你已经在使用 v0.76.x 或 v0.77.0,升级后原有会话、模型配置和本地数据会继续沿用。
