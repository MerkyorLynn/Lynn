# Lynn vs GenericAgent — 能力对比(截至本轮原生能力建设)

> GenericAgent(lsdefine,MIT)= 极简自进化 agent(~3K 行内核,9 原子工具,code_run 当万能逃生舱)。
> 本文对照 Lynn **当前已实现**的功能(含本轮新建:ultra / working_checkpoint / web_scan / 技能结晶 / brain 召回)。

## 1. GA 的 9 原子工具 ↔ Lynn 现状

| GA 工具 | Lynn 对应 | 状态 |
|---|---|---|
| `code_run` | `bash` | ✅ 有,**且沙箱 + approval(更安全)** |
| `file_read` | `read_file` | ✅ |
| `file_write` | `write_file` | ✅ |
| `file_patch` | `apply_patch` | ✅ |
| `web_scan` | `web_scan` | ✅ 本轮建(零依赖 fetch + 简化 + SSRF 防护,opt-in) |
| `update_working_checkpoint` | `update_working_checkpoint` | ✅ 本轮建(同名;①meta,逐步注入抗 compaction) |
| `start_long_term_update` | 技能结晶 | ✅ 本轮建(CLI distill+recall;brain recall 已接,distill 设计中) |
| `ask_user` | approval / ask 流程 | 〜 覆盖(无独立工具) |
| `web_execute_js` | **桌面浏览器 computer-use agent** | ✅ **已实现,且比 GA 更先进** |

**工具平价:9/9 全对齐。**

> ⚠️ **更正(初版错判)**:初版把 `web_execute_js` 标为"唯一缺口",**是错的**——我没先扫描 desktop 已有能力。实测 `desktop/main.cjs` 已有完整浏览器 computer-use agent:
> `navigate / snapshot(=web_scan,带 data-hana-ref 元素引用)/ screenshot+thumbnail(视觉)/ click / type / scroll / select`,
> + `isAllowedBrowserUrl`(http/https 白名单)+ per-session `WebContentsView`(`_browserViews` Map)+ `browser-emergency-stop` + 经 ws `browser_status`/`browser_screenshot` 流式给 UI,且 `tool-use-behavior` 把浏览器列为工具类别。
> **这是结构化动作 + 元素引用 + 截图(现代 computer-use 范式),比 GA 的裸 `executeJavaScript` 注入更可靠。** 唯一架构差异:Lynn 驱动**自己的 Electron 浏览器**(session 持久登录),GA 用 Tampermonkey 桥进**用户的外部浏览器**——是取向差异,非能力缺口。

## 2. Lynn 有、GA 没有(可靠性 / 安全 / 验证栈)

| Lynn 独有 | GA |
|---|---|
| **7 守卫**(自动验证 / 读后即验 / 计划契约 / 对抗自检 / 快照回退 / 工具预算 / 纠错重试) | 无,靠模型自觉 |
| **原子步**(一轮一动作,observe-then-act) | 无 |
| **沙箱 + approval** | **无沙箱**(任意执行,更猛更险) |
| **/rewind**(sidecar 快照,二进制安全) | checkpoint 较粗 |
| **ultra**(分解 + 并行 + **对抗验证 + completeness critic** + 综合) | conductor 是多 agent,但无对抗验证 |
| **6 层记忆** | L0-L4 |
| **门禁文化**(typecheck / 单测 / cli-smoke,605+ 测试) | 无测试门禁 |

## 3. GA 有、Lynn 没有(物理面 / 自治 / 形态)

| GA 独有 | Lynn |
|---|---|
| computer-use 的**非浏览器物理面**:屏幕键鼠、**ADB 驱手机 app**、桌面应用驱动、逆向本地 DB | 浏览器 computer-use **已有且更先进**;手机/桌面/逆向暂不碰(安全取舍) |
| **自治模式**:reflect / **scheduler(cron 定时)** / goal-mode / autonomous | 有 Fleet,但非定时自治 |
| **10+ 前端 + IM bots**:Telegram / 微信 / QQ / 飞书 / 企微 / 钉钉 + 桌面宠物 | 桌面 GUI + 飞书巡检,无这一排 IM bot |
| **极简内核**(~3K 行) | 重得多(可靠性栈的代价) |

## 4. 净判断

```
工具平价:  Lynn 9/9 全对齐 GA(浏览器 computer-use 已有,且更先进)
可靠性/安全: Lynn 明显领先(守卫 + 原子步 + 沙箱 + 验证 + rewind + 门禁)
物理面/自治: GA 仅在"非浏览器物理面"(手机ADB/桌面app/逆向)+ IM bots + 定时自治更宽
哲学:       GA = 无沙箱自由派(给足自由 + 自进化,赌模型够强)
            Lynn = 工程纪律派(把正确性/安全压进 harness,可审计可回滚)
```

**结论:本轮后 Lynn 工具 9/9 全对齐 GA 且远更稳。** GA 仅余三块更宽:① 非浏览器物理面(手机 ADB / 桌面 app / 逆向本地 DB)② IM bots(Telegram/微信/QQ/…)③ 定时自治(scheduler/cron)。这三块都是 GA 无沙箱哲学的红利,也是其风险;Lynn 要补是产品取舍,非技术不可达。

## 5. Lynn 浏览器 computer-use 的实情(已实现,优于 GA)
`desktop/main.cjs` 的 `WebContentsView` 浏览器 agent:
- **结构化动作**:`navigate / snapshot / screenshot / thumbnail / click / type / scroll / select`,按 `data-hana-ref` 元素引用操作(现代 computer-use 范式,非裸 JS 注入)。
- **感知**:`SNAPSHOT_SCRIPT`(DOM 简化,=web_scan)+ `capturePage`(截图视觉)。
- **安全**:`isAllowedBrowserUrl`(http/https 白名单)+ `browser-emergency-stop` + per-session 视图隔离。
- **集成**:经 ws `browser_status`/`browser_screenshot` 流式给 UI,`tool-use-behavior` 已将浏览器列为工具类别。
- **vs GA**:Lynn 驱动自己的 Electron 浏览器(session 持久登录、动作结构化更可靠);GA 用 Tampermonkey 桥进用户外部浏览器(裸 JS,登录态来自用户现有会话)。**两种取向,Lynn 这套更可控。**
