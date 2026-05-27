# MiMo V2.5 Pro 评测 — 腾讯云后台跑指南

## 一句话起跑(本机预演)

```bash
# 0. dry-run 验 plumbing(不真调 API)
node scripts/mimo-v25-pro-eval.mjs --dry-run --out /tmp/mimo-dry

# 1. 真跑 worktree 内 smoke(56 题:7×6 suite + V8 9 题,thinking-on 上下文 32K)
MIMO_PRO_KEY=sk-xxx node scripts/mimo-v25-pro-eval.mjs \
  --out reports/mimo-pro-smoke-$(date +%Y%m%d-%H%M%S)
```

## 完整 run 数据准备(canonical eval 量级)

按 memory `feedback_eval_sample_sizes_canonical_20260520.md`:**MMLU 500 / GPQA Diamond 198,不允许子集**。

worktree 内只有 smoke 子集(7 题 ×N suite),完整数据需外部下载:

```bash
# MMLU test split → 抽 500 题(stratified by subject)
huggingface-cli download cais/mmlu --repo-type dataset \
  --local-dir /data/mmlu_raw
# 抽样脚本(用户已有的 sampler 或简单 random.seed(42).sample(500))
python -c "
import json, random
random.seed(42)
# 从 mmlu_raw/all/test.json 抽 500,转成 {qid, question, choices:[4], answer:0-3}
# ... (略,user 自己写)
" > /data/mmlu_500.json

# GPQA Diamond 198 全集
huggingface-cli download Idavidrein/gpqa --repo-type dataset \
  --local-dir /data/gpqa_raw
# 转换为 worktree 同 shape:{qid, problem, answer:'A/B/C/D'}

# HumanEval(evalplus 增强版)164 题
huggingface-cli download evalplus/humanevalplus --repo-type dataset \
  --local-dir /data/humaneval_raw
```

> 注:MMLU/GPQA/HumanEval 全集 user 在 N5 上很可能已有(memory 提及多次)。如果有,直接传路径用。

## 腾讯云后台跑(完整套件)

ssh 到腾讯云后:

```bash
# 1. clone / pull worktree
cd /data/lynn-worktree
git fetch && git checkout claude/frosty-swirles-98de1c

# 2. 装依赖(node 20+)
npm ci  # 或 npm install --omit=dev

# 3. 配 API key(写到 ~/.lynn/brain.env 或 export)
export MIMO_PRO_KEY=sk-xxxxx
# 或:echo "MIMO_PRO_KEY=sk-xxxxx" >> ~/.lynn/brain.env

# 4. nohup 后台跑(完整数据集路径请实际替换)
OUT_DIR=/data/reports/mimo-v25-pro/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT_DIR"
nohup node scripts/mimo-v25-pro-eval.mjs \
  --mmlu-path /data/mmlu_500.json \
  --gpqa-path /data/gpqa_diamond_198.json \
  --humaneval-path /data/humaneval_plus_164.json \
  --suite mmlu,gpqa,humaneval,aime,finance,medqa,v8 \
  --concurrency 4 \
  --max-tokens 32768 \
  --thinking enabled \
  --out "$OUT_DIR" \
  > "$OUT_DIR/nohup.log" 2>&1 &

echo "PID: $!" | tee "$OUT_DIR/pid.txt"
echo "Watching: tail -f $OUT_DIR/run.log"
```

## 监控进度

```bash
# 实时 tail
tail -f /data/reports/mimo-v25-pro/<timestamp>/run.log

# 看每个 suite 的 acc
tail -1 /data/reports/mimo-v25-pro/<timestamp>/run.log

# 看 summary.json(跑完后写)
cat /data/reports/mimo-v25-pro/<timestamp>/summary.json | jq

# 看具体某题答得对不对
cat /data/reports/mimo-v25-pro/<timestamp>/gpqa.jsonl | jq -c '{qid, correct, pred, answer}'
```

## 中途中断/恢复

```bash
# 中断:Ctrl+C 或 kill $(cat /data/reports/mimo-v25-pro/<ts>/pid.txt)
# 恢复:加 --resume,会跳过已写入 .jsonl 的 qid
node scripts/mimo-v25-pro-eval.mjs --resume --out /data/reports/mimo-v25-pro/<ts> ...
```

## 预期时长 / quota

- 198 + 500 + 164 + 9(v8 coding) ≈ **870 题**
- thinking-on,每题 8-20s(MiMo 文档无 latency 保证,xhigh 推理偏长)
- concurrency=4 → 总时长 **~30-60 分钟**(实际看 MiMo API rate limit)
- token 消耗:每题 input 平均 200 token,thinking-on output 平均 2-5k token
  → 总计 ≈ **870 × 3k = 2.6M tokens**
- MiMo Token Plan 配额够不够看个人套餐;**eval 不开 enable_search,不会额外烧搜索配额**

## 输出格式

```
<OUT_DIR>/
├── summary.json           # 总结:每 suite acc + p50/p95 latency
├── run.log                # 主日志
├── gpqa.jsonl             # 每题 detail(qid, prompt, response, pred, correct, ms, usage)
├── humaneval.jsonl
├── aime.jsonl
├── finance.jsonl
├── medqa.jsonl
├── mmlu.jsonl
└── v8.jsonl
```

## HumanEval 注意

worktree 里的 grader **只做静态格式 sanity**(检查有 `def entry_point` + 长度 > 50)。
真实的 functional correctness 要用 evalplus harness:

```bash
# 跑完 eval 后用 evalplus 评分(在腾讯云装好 evalplus)
pip install evalplus
# 把 humaneval.jsonl 转成 evalplus 期望的格式后:
evalplus.evaluate --samples mimo-humaneval-converted.jsonl --dataset humaneval
```

我们 jsonl 里有 `response_excerpt` 字段保留模型的代码,后处理转 evalplus 即可。

## 调试小窍门

- **smoke 数据集全跑**: `--suite v8` 只跑 9 道 V8(含 coding spike),5 分钟可见
- **单 suite 重跑**: `--suite gpqa --resume` 只补 GPQA 没跑完的题
- **更快迭代**: `--max-tokens 8192 --thinking disabled` 但**会改变结果质量**,不能作为正式数字
- **API rate-limit 撞墙**: 把 `--concurrency 4` 降到 2 或 1

## 与 canonical 数据对比

| Eval | MiMo V2.5 Pro 期望(待测) | 参考数字(memory) |
|---|---|---|
| MMLU 500 (thinking-on) | ? | Qwen3.6-35B BF16 86.40,Lynn NVFP4 84.40 |
| GPQA Diamond 198 (thinking-on) | ? | Qwen3.6-35B BF16 45.45,Lynn NVFP4 49.49 |
| HumanEval 164 (thinking-on) | ? | 无 baseline,这次开盘 |
| AIME(7 题 smoke) | ? | 无 baseline |

跑完把 `summary.json` 的 accuracy 填上,可以横向对比 Qwen3.6-35B-A3B / Lynn-V4-Pro / DeepSeek-V4-Pro。
