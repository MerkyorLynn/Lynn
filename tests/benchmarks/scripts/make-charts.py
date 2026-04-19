#!/usr/bin/env python3
"""
Lynn 测试结果可视化 · 生成雷达图 + 柱状图 PNG
用法: python3 make-charts.py /tmp/hard-test-v3-<HHMM>.json
"""
import json
import sys
import os

# 静默导入
try:
    import matplotlib
    matplotlib.use("Agg")  # 无头
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib import rcParams
except ImportError:
    print("需要 pip install matplotlib numpy")
    sys.exit(1)

# 中文字体 · 显式注册 + 设置
from matplotlib import font_manager as fm
FONT_PATHS = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]
for fp in FONT_PATHS:
    try:
        fm.fontManager.addfont(fp)
    except Exception:
        pass
rcParams["font.sans-serif"] = ["Hiragino Sans GB", "STHeiti", "Arial Unicode MS", "Heiti SC", "DejaVu Sans"]
rcParams["font.family"] = "sans-serif"
rcParams["axes.unicode_minus"] = False

# 柔和品牌配色
COLORS = {
    "Qwen3.6-A3B 本地":  "#e74c3c",  # 冠军 红（A3B MoE）
    "Qwen3-32B 本地":   "#ff9f43",  # 亚军 橙
    "glm-5-turbo":     "#4ecdc4",
    "Kimi K2.5":       "#feca57",
    "MiniMax M2.7":    "#9c88ff",
    "Step-3.5-Flash":  "#54a0ff",
    "DeepSeek V3.2":   "#5f27cd",
}


def load_data(json_path):
    with open(json_path) as f:
        return json.load(f)


def aggregate_by_scene(data):
    """每个模型在每个场景的平均得分"""
    results = data["results"]
    models = data["models"]
    # 组合场景（同 scene 下多题取平均）
    scene_order = []
    by_scene = {m: {} for m in models}
    for m in models:
        tests = results[m]
        scenes = {}
        for tid, r in tests.items():
            scene = r["scene"]
            if scene not in scenes:
                scenes[scene] = []
            scenes[scene].append(r["score"])
        for s, scores in scenes.items():
            avg = sum(scores) / len(scores) / 3 * 100  # 归一化成 0-100 百分比
            by_scene[m][s] = avg
            if s not in scene_order:
                scene_order.append(s)
    return scene_order, by_scene


def make_radar(data, out_path):
    """雷达图：6 模型 × 6 场景"""
    scenes, by_scene = aggregate_by_scene(data)
    # 规范场景顺序（放 emoji 开头的 6 档）
    fixed = [s for s in ["📰 新闻", "🎬 娱乐", "🏠 生活", "💼 日常工作", "💰 财经", "⚽ 体育",
                         "🔧 错误恢复", "🛡️ 安全", "📜 长上下文"] if s in scenes]

    N = len(fixed)
    angles = np.linspace(0, 2 * np.pi, N, endpoint=False).tolist()
    angles += angles[:1]  # close the loop

    fig, ax = plt.subplots(figsize=(10, 10), subplot_kw=dict(polar=True))
    ax.set_theta_offset(np.pi / 2)
    ax.set_theta_direction(-1)

    # 网格圈用百分比标
    ax.set_rgrids([20, 40, 60, 80, 100], labels=["20%", "40%", "60%", "80%", "100%"],
                  angle=0, fontsize=10, color="#64748b")
    ax.set_ylim(0, 100)
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(fixed, fontsize=12, fontweight="600")

    for model in data["models"]:
        values = [by_scene[model].get(s, 0) for s in fixed]
        values += values[:1]
        color = COLORS.get(model, "#999999")
        ax.plot(angles, values, linewidth=2.5, label=model, color=color, marker="o", markersize=6)
        ax.fill(angles, values, alpha=0.12, color=color)

    ax.legend(loc="upper right", bbox_to_anchor=(1.28, 1.1), fontsize=11, frameon=False)
    plt.title("工具调用能力雷达图 · 24 题 × 6 模型\n（百分比 = 完美率）",
              fontsize=16, fontweight="700", pad=30, color="#1e293b")

    plt.tight_layout()
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    print(f"✅ 雷达图: {out_path}")


def make_score_bar(data, out_path):
    """柱状图：总分 + 平均延迟双 Y 轴"""
    models = data["models"]
    results = data["results"]

    totals = []
    avg_latencies = []
    for m in models:
        total = sum(r["score"] for r in results[m].values())
        lats = [r["latency"] for r in results[m].values() if not r["error"]]
        avg = sum(lats) / len(lats) if lats else 0
        totals.append(total)
        avg_latencies.append(avg / 1000)  # 转秒

    # 按总分排序
    order = sorted(range(len(models)), key=lambda i: -totals[i])
    models_s = [models[i] for i in order]
    totals_s = [totals[i] for i in order]
    lats_s = [avg_latencies[i] for i in order]
    colors_s = [COLORS.get(m, "#999") for m in models_s]

    fig, ax1 = plt.subplots(figsize=(13, 7))
    x = np.arange(len(models_s))
    width = 0.35

    # 得分（左 Y 轴）
    bars1 = ax1.bar(x - width / 2, totals_s, width, label="总分（/72）",
                    color=colors_s, edgecolor="#1e293b", linewidth=1.5)
    ax1.set_ylabel("总分", fontsize=13, fontweight="600", color="#1e293b")
    ax1.set_ylim(0, 75)
    ax1.tick_params(axis="y", labelcolor="#1e293b")
    for b, v in zip(bars1, totals_s):
        ax1.text(b.get_x() + b.get_width() / 2, v + 1, f"{v}",
                 ha="center", va="bottom", fontsize=12, fontweight="700", color="#1e293b")

    # 延迟（右 Y 轴）
    ax2 = ax1.twinx()
    bars2 = ax2.bar(x + width / 2, lats_s, width, label="平均延迟 (秒)",
                    color="#94a3b8", alpha=0.5, edgecolor="#475569", linewidth=1)
    ax2.set_ylabel("平均延迟 (秒)", fontsize=13, fontweight="600", color="#475569")
    ax2.set_ylim(0, max(lats_s) * 1.3 + 2)
    ax2.tick_params(axis="y", labelcolor="#475569")
    for b, v in zip(bars2, lats_s):
        ax2.text(b.get_x() + b.get_width() / 2, v + 0.2, f"{v:.1f}s",
                 ha="center", va="bottom", fontsize=10, color="#475569")

    ax1.set_xticks(x)
    ax1.set_xticklabels(models_s, fontsize=11, rotation=15, ha="right")
    ax1.set_axisbelow(True)
    ax1.grid(axis="y", alpha=0.3)

    # 合并 legend
    l1, lb1 = ax1.get_legend_handles_labels()
    l2, lb2 = ax2.get_legend_handles_labels()
    ax1.legend(l1 + l2, lb1 + lb2, loc="upper right", fontsize=11, frameon=False)

    plt.title("🏆 6 模型工具调用总分 + 延迟对比 · 24 题",
              fontsize=15, fontweight="700", pad=20, color="#1e293b")

    plt.tight_layout()
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    print(f"✅ 柱状图: {out_path}")


def make_difficulty_heatmap(data, out_path):
    """难度档分布热图：每档的完美率（颜色越深越好）"""
    models = data["models"]
    results = data["results"]

    # 分档：基础 vs 错误恢复 vs 安全 vs 长上下文
    buckets = {
        "基础 (12 题)": lambda tid: tid[0] in "NELWFS",
        "🔧 错误恢复": lambda tid: tid.startswith("ER"),
        "🛡️ 安全拒绝": lambda tid: tid.startswith("SR"),
        "📜 长上下文": lambda tid: tid.startswith("LC"),
    }

    matrix = []
    for model in models:
        row = []
        for bname, bfilter in buckets.items():
            matching = [r["score"] for tid, r in results[model].items() if bfilter(tid)]
            if matching:
                perfect_rate = sum(1 for s in matching if s == 3) / len(matching) * 100
                row.append(perfect_rate)
            else:
                row.append(0)
        matrix.append(row)

    fig, ax = plt.subplots(figsize=(11, 7))
    im = ax.imshow(matrix, cmap="RdYlGn", vmin=0, vmax=100, aspect="auto")

    ax.set_xticks(range(len(buckets)))
    ax.set_xticklabels(list(buckets.keys()), fontsize=12, fontweight="600")
    ax.set_yticks(range(len(models)))
    ax.set_yticklabels(models, fontsize=12, fontweight="600")

    for i in range(len(models)):
        for j in range(len(buckets)):
            val = matrix[i][j]
            color = "white" if val < 50 else "black"
            ax.text(j, i, f"{val:.0f}%", ha="center", va="center",
                    color=color, fontsize=13, fontweight="700")

    cbar = plt.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label("完美率 %", fontsize=11)

    plt.title("📊 按难度档完美率热图（4 档 × 6 模型）",
              fontsize=15, fontweight="700", pad=15, color="#1e293b")

    plt.tight_layout()
    plt.savefig(out_path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close()
    print(f"✅ 热图: {out_path}")


def main():
    if len(sys.argv) < 2:
        print("用法: python3 make-charts.py <json 文件>")
        sys.exit(1)

    json_path = sys.argv[1]
    if not os.path.exists(json_path):
        print(f"找不到文件: {json_path}")
        sys.exit(1)

    data = load_data(json_path)
    base = os.path.splitext(json_path)[0]

    make_radar(data, base + "-radar.png")
    make_score_bar(data, base + "-scorebar.png")
    make_difficulty_heatmap(data, base + "-heatmap.png")

    print("\n✅ 3 张图生成完毕")


if __name__ == "__main__":
    main()
