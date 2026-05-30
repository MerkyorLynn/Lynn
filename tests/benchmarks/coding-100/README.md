# coding-100 — 多语言执行验证编码 benchmark

100 道**实战难 / 极难**编码题(10 语言 × 10 题,每语言约 4 硬 + 6 极难,**无送分题**),
全部**执行验证**:把模型生成的代码真编译 / 真运行,跑隐藏断言判 pass@1,而不是关键词匹配。

覆盖语言:`Python · JavaScript · TypeScript · Rust · Go · C++ · SQL · Bash · CSS · HTML`。
跨切面能力(并发、async、高级类型、可访问性 a11y、正则、零拷贝/所有权等)折进对应语言的难题里。

## 目录

```
harness.mjs          # 运行器(自检 + 评测,Node ESM)
problems/01_python.mjs … 10_html.mjs   # 题库,每文件 10 题
results.json         # 评测产物(运行后生成)
```

每道题是一个对象:

```js
{ id, lang, prompt, test, canonical }
```

- `prompt`:给模型看的题面(精确给出函数签名 / 输出契约,要求只返回代码)。
- `test`:**断言**(失败即 throw / 非零退出);harness 统一追加成功标记,断言里不写它。
- `canonical`:一份正确参考解,仅用于 `SELFTEST` 自检 harness 与断言是否正确。

## 校验方式(各语言 harness contract)

| 语言 | 组装 / 执行 |
|---|---|
| Python | `canonical + test` → `python3` |
| JavaScript | `canonical`(`module.exports`)+ IIFE 注入断言 → `node`(CJS) |
| TypeScript | `canonical + test` → `tsc`(es2022/commonjs,**类型错误=fail**)→ `node` |
| Rust | `canonical` + 注入 `fn main(){…}` → `rustc -O --edition 2021` → 运行 |
| Go | `package main` + `fmt/os` + `canonical`(import-free)+ `main` → `go run` |
| C++ | `bits/stdc++.h` + `canonical` + `main(){…}` → `g++ -O2 -std=c++17` → 运行 |
| SQL | python 内置 `sqlite3`:建表插数据 → 跑模型 query → `fetchall()` 精确比对 |
| Bash | 跑模型脚本取 stdout → bash 断言(`set -e`) |
| CSS | `css-tree` 解析 → 提供 `RULES / MEDIA / rule() / decl()` → 跑断言 |
| HTML | `jsdom` 解析 → 提供 `doc / $() / $$()` → 跑断言 |

## 依赖

- `python3`(3.11+)、`node`(≥20)、`g++`(C++17)、`rustc`(2021)、`go`(1.21+)、`bash`
- 本目录安装 JS 工具:`npm i typescript jsdom css-tree`
- 工具不在 PATH 时用 env 覆盖:`RUSTC` / `GO` / `TSC` / `CBENCH_NODE_MODULES`

## 运行

**自检**(用 canonical 验证 harness + 断言全部正确,应 100/100):

```bash
SELFTEST=1 node harness.mjs
```

**评测一个模型**(任意 OpenAI 兼容 `/chat/completions` 端点):

```bash
API_KEY=sk-... API_BASE=https://api.openai.com/v1 MODEL=gpt-4o node harness.mjs
# → 打印逐题 PASS/FAIL + 分语言汇总,并写 results.json
```

环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `API_KEY` / `API_BASE` / `MODEL` | — / openai / gpt-4o | 端点与模型(兼容 `STEPFUN_*` 别名) |
| `REASONING_EFFORT` | `high` | reasoning 模型档位(low/medium/high) |
| `MAX_TOKENS` | `32768` | **务必给够** —— 高推理预算不足会被截断成空答 |
| `SEND_REASONING_EFFORT` | `1` | 非 reasoning 模型设 `0`,不发该字段 |
| `CONC` | `4` | 并发请求数 |

> ⚠️ 高 reasoning 模型在硬题上单条可生成上万 token,`MAX_TOKENS` 给小了会让 reasoning 吃光预算、
> 输出空 content(被误判 fail)。默认 32768,按需调大。

## 出处

2026-05-30 为评测 StepFun step-3.7-flash 编码能力而建;并行多 agent 出题、中心化 `SELFTEST` 100/100 验证
(所有 canonical 真编译/真运行通过各自隐藏断言)。可复用于任意模型横评。
