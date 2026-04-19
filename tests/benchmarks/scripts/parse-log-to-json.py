#!/usr/bin/env python3
"""解析 benchmark 部分日志 → 构造临时 JSON（让 make-charts.py 能跑）"""
import json
import re
import sys

# 24 题的 scene 映射（从测试脚本抄过来）
SCENE_MAP = {
    "N1": "📰 新闻", "N2": "📰 新闻",
    "E1": "🎬 娱乐", "E2": "🎬 娱乐",
    "L1": "🏠 生活", "L2": "🏠 生活",
    "W1": "💼 日常工作", "W2": "💼 日常工作",
    "F1": "💰 财经", "F2": "💰 财经",
    "S1": "⚽ 体育", "S2": "⚽ 体育",
    "ER1": "🔧 错误恢复", "ER2": "🔧 错误恢复",
    "ER3": "🔧 错误恢复", "ER4": "🔧 错误恢复",
    "SR1": "🛡️ 安全", "SR2": "🛡️ 安全",
    "SR3": "🛡️ 安全", "SR4": "🛡️ 安全",
    "LC1": "📜 长上下文", "LC2": "📜 长上下文",
    "LC3": "📜 长上下文", "LC4": "📜 长上下文",
}

# 解析每行：
# "  N1    📰 新闻           ✅ 3/3 ·  1012ms · ✅ 完美 · 1 个工具"
LINE_RE = re.compile(
    r'^\s*([A-Z]+\d+)\s+.+?\s+(✅|🟡|⚠️|❌)\s+(\d+)/3\s+·\s+(\d+)ms'
)

MODEL_HEAD_RE = re.compile(r'^📊 (.+?) \.\.\.')


def main(log_path, out_path):
    with open(log_path) as f:
        lines = f.readlines()

    results = {}
    models_order = []
    current_model = None

    for line in lines:
        mh = MODEL_HEAD_RE.match(line.strip())
        if mh:
            current_model = mh.group(1)
            if current_model not in models_order:
                models_order.append(current_model)
                results[current_model] = {}
            continue

        if current_model:
            m = LINE_RE.match(line)
            if m:
                tid = m.group(1)
                score = int(m.group(3))
                latency = int(m.group(4))
                scene = SCENE_MAP.get(tid, "未知")
                results[current_model][tid] = {
                    "score": score,
                    "latency": latency,
                    "scene": scene,
                    "error": score == 0,
                }

    # 只保留已完成至少 20 题的模型
    models_kept = [m for m in models_order if len(results[m]) >= 20]
    results_kept = {m: results[m] for m in models_kept}

    out = {
        "models": models_kept,
        "results": results_kept,
        "note": "部分测试 DEMO 数据（benchmark 仍在跑）",
    }
    with open(out_path, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"✅ 写入 {out_path}")
    print(f"模型数: {len(models_kept)}")
    for m in models_kept:
        n = len(results_kept[m])
        total = sum(r["score"] for r in results_kept[m].values())
        print(f"  {m}: {n} 题完成, 总分 {total}/{n*3}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
