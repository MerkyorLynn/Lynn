"""
V9 可视化 · 12 家 × 8 维度 + V8 vs V9 对比

输出 PNG 到 v9/charts/:
    1. v9-leaderboard.png · 12 家总分横向柱状(配色:T0/T1/T2/T3)
    2. v9-heatmap.png · 12 家 × 8 维度子分热力图
    3. v9-vs-v8.png · 同模型 V8 → V9 排名变化(箭头图)
    4. qwen3-deployment.png · Qwen3.6 三部署对比(Spark / 4090 / 官方)
"""
import json
import glob
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# ── V8 风格科技黑底 ──
BG, PANEL, BORDER = '#0d1117', '#161b22', '#30363d'
TEXT_MAIN, TEXT_DIM = '#e6edf3', '#7d8590'
C_GOLD, C_GREEN, C_BLUE, C_PURPLE, C_ORANGE, C_CYAN, C_GRAY, C_RED = \
    '#f0c419', '#3fb950', '#58a6ff', '#a371f7', '#f0883e', '#39d0d8', '#484f58', '#f85149'

plt.rcParams.update({
    'font.sans-serif': ['PingFang SC', 'Heiti SC', 'Arial Unicode MS', 'DejaVu Sans'],
    'font.monospace': ['Menlo', 'DejaVu Sans Mono'],
    'axes.unicode_minus': False,
    'figure.facecolor': BG, 'axes.facecolor': BG, 'savefig.facecolor': BG,
    'axes.edgecolor': BORDER, 'axes.labelcolor': TEXT_DIM,
    'xtick.color': TEXT_DIM, 'ytick.color': TEXT_DIM, 'text.color': TEXT_MAIN,
    'axes.spines.top': False, 'axes.spines.right': False,
})

V9_DIR = Path(__file__).parent.parent
RESULTS_DIR = V9_DIR / "results"
CHARTS_DIR = V9_DIR / "charts"
CHARTS_DIR.mkdir(parents=True, exist_ok=True)


PROVIDER_EXCLUDED = {'Qwen3.6-Plus','Step-3.5-Flash','Gemini 2.5 Pro','Gemini 2.5 Flash'}

def load_v9_data():
    """聚合 v9 results · 砍 sql 维度"""
    files = sorted(glob.glob(str(RESULTS_DIR / "v9_*.json")))
    agg = {}
    for f in files:
        d = json.load(open(f))
        pname = d.get("provider", "?")
        if pname in PROVIDER_EXCLUDED: continue
        score_d = d.get("subset_score", {})
        total_d = d.get("subset_total", {})
        if not total_d:
            continue
        if pname not in agg:
            agg[pname] = {}
        for s, t in total_d.items():
            if s == "sql":
                continue
            c = score_d.get(s, 0)
            if s not in agg[pname] or t > agg[pname][s][1]:
                agg[pname][s] = (c, t)
    return agg


# V8 reference scores (from HANDOVER-V8-FINAL.md)
V8_SCORES = {
    "GPT-5.5 (Codex)": 235, "GPT-5.4 (Codex)": 234,
    "Qwen3.6-27B (Spark)": 224,  # was top open
    "Qwen3.6-A3B (4090)": 219,
    "Qwen3.6-Plus": 219,
    "DeepSeek V4-Pro": 218,
    "DeepSeek V4-Flash": 217,
    "DeepSeek V3.2 (4-21)": 215,
    "Kimi K2.6": 202,
    "GLM-5-Turbo": 186,
    "GLM-5.1": 170,
    "MiniMax M2.7": 164,
    "Step-3.5-Flash": 162,
}


def get_total_pct(sub_data):
    fields = ["math", "physics", "chemistry", "biology", "longctx", "code_algo", "medical", "finance"]
    tc = sum(sub_data.get(s, (0, 0))[0] for s in fields)
    tt = sum(sub_data.get(s, (0, 0))[1] for s in fields)
    return tc, tt, (100 * tc / tt) if tt else 0


# ─── 图 1 · Leaderboard 横向柱状 ───
def render_leaderboard(agg):
    fig, ax = plt.subplots(figsize=(11, 7))
    items = []
    for p, sd in agg.items():
        tc, tt, pct = get_total_pct(sd)
        if tt < 16:
            continue  # 跳过不完整数据
        items.append((p, tc, tt, pct))
    items.sort(key=lambda x: -x[3])

    names = [x[0] for x in items]
    pcts = [x[3] for x in items]

    # T0 学霸 / T1 偏科 / T2 平庸 / T3 落榜
    colors = []
    for p in pcts:
        if p >= 75: colors.append(C_GOLD)      # 金 学霸
        elif p >= 60: colors.append(C_GREEN)   # 绿 偏科牛马
        elif p >= 50: colors.append(C_BLUE)    # 蓝 平庸打工
        else: colors.append(C_GRAY)            # 灰 落榜

    bars = ax.barh(range(len(names)), pcts, color=colors, edgecolor=BORDER, linewidth=0.8, alpha=0.92)
    ax.set_yticks(range(len(names)))
    ax.set_yticklabels(names, fontsize=10, color=TEXT_MAIN)
    ax.invert_yaxis()
    ax.set_xlabel("V9 得分 % (24 题 · 8 维度全自动 verifier)", fontsize=11, color=TEXT_DIM)
    ax.set_title("中美典型大模型超高难度试题横向测评",
                 fontsize=16, fontweight="bold", pad=15, color=TEXT_MAIN)
    ax.set_xlim(0, 100)
    ax.grid(axis="x", alpha=0.2, color=BORDER, linestyle='--')
    ax.set_axisbelow(True)

    for i, (n, c, t, p) in enumerate(items):
        ax.text(p + 1, i, f"  {c}/{t}  =  {p:.1f}%", va="center", fontsize=9,
                color=TEXT_MAIN, family='monospace')

    legend = [
        mpatches.Patch(color=C_GOLD, label="T0 学霸 ≥75%"),
        mpatches.Patch(color=C_GREEN, label="T1 偏科牛马 60-75%"),
        mpatches.Patch(color=C_BLUE, label="T2 平庸打工 50-60%"),
        mpatches.Patch(color=C_GRAY, label="T3 落榜生 <50%"),
    ]
    leg = ax.legend(handles=legend, loc="lower right", fontsize=9,
                    facecolor=PANEL, edgecolor=BORDER, labelcolor=TEXT_MAIN)
    plt.tight_layout()
    out = CHARTS_DIR / "v9-leaderboard.png"
    plt.savefig(out, dpi=180, facecolor=BG, bbox_inches='tight')
    plt.close()
    print(f"  ✓ {out.name}")


# ─── 图 2 · Heatmap 子分 ───
def render_heatmap(agg):
    fields_disp = ["数学", "物理", "化学", "生物", "长ctx", "编程", "医学", "金融"]
    fields_key = ["math", "physics", "chemistry", "biology", "longctx", "code_algo", "medical", "finance"]

    items = []
    for p, sd in agg.items():
        tc, tt, pct = get_total_pct(sd)
        if tt < 16:
            continue
        items.append((p, sd, pct))
    items.sort(key=lambda x: -x[2])

    matrix = []
    for p, sd, pct in items:
        row = []
        for s in fields_key:
            if s in sd:
                c, t = sd[s]
                row.append(c / t if t else 0)
            else:
                row.append(np.nan)
        matrix.append(row)
    matrix = np.array(matrix)

    fig, ax = plt.subplots(figsize=(11, 7.5))
    # 自定义 colormap · 暗主题适配(灰色 → 青绿)
    from matplotlib.colors import LinearSegmentedColormap
    dark_cmap = LinearSegmentedColormap.from_list(
        "dark_cmap",
        [(0.0, '#3d1d1d'), (0.34, '#5a3a3a'), (0.50, C_GRAY),
         (0.67, '#1d4a3a'), (1.0, C_GREEN)],
        N=256
    )
    im = ax.imshow(matrix, aspect="auto", cmap=dark_cmap, vmin=0, vmax=1)

    ax.set_xticks(range(len(fields_disp)))
    ax.set_xticklabels(fields_disp, fontsize=11, color=TEXT_MAIN)
    ax.set_yticks(range(len(items)))
    ax.set_yticklabels([x[0] for x in items], fontsize=10, color=TEXT_MAIN)
    ax.set_title("中美典型大模型超高难度试题得分热力图", fontsize=15, fontweight="bold", pad=14, color=TEXT_MAIN)

    for i, (p, sd, pct) in enumerate(items):
        for j, s in enumerate(fields_key):
            if s in sd:
                c, t = sd[s]
                ax.text(j, i, f"{c}/{t}", ha="center", va="center",
                        color=TEXT_MAIN, fontsize=10, fontweight="bold", family='monospace')
            else:
                ax.text(j, i, "—", ha="center", va="center", color=TEXT_DIM, fontsize=10)

    # tick 边框淡化
    for spine in ax.spines.values():
        spine.set_edgecolor(BORDER)
    ax.tick_params(colors=TEXT_DIM, which='both')

    cbar = fig.colorbar(im, ax=ax, fraction=0.025, pad=0.02)
    cbar.set_label("正确率", fontsize=10, color=TEXT_DIM)
    cbar.ax.yaxis.set_tick_params(color=TEXT_DIM)
    plt.setp(plt.getp(cbar.ax.axes, 'yticklabels'), color=TEXT_DIM)
    plt.tight_layout()
    out = CHARTS_DIR / "v9-heatmap.png"
    plt.savefig(out, dpi=180, facecolor=BG, bbox_inches='tight')
    plt.close()
    print(f"  ✓ {out.name}")


# ─── 图 3 · V8 vs V9 排名变化 ───
def render_v8_vs_v9(agg):
    # V8 ranks
    v8_sorted = sorted(V8_SCORES.items(), key=lambda x: -x[1])
    v8_rank = {p: i + 1 for i, (p, _) in enumerate(v8_sorted)}

    # V9 ranks
    v9_items = []
    for p, sd in agg.items():
        tc, tt, pct = get_total_pct(sd)
        if tt < 16:
            continue
        v9_items.append((p, pct))
    v9_items.sort(key=lambda x: -x[1])
    v9_rank = {p: i + 1 for i, (p, _) in enumerate(v9_items)}

    # 匹配 · alias 处理
    aliases = {
        "Qwen3.6-A3B (Spark)": "Qwen3.6-27B (Spark)",  # V8 时在 Spark 跑 27B(本质 35B-A3B)
        "Qwen3.6-27B (4090)": "Qwen3.6-A3B (4090)",   # V8 时叫 A3B(同模型不同名)
    }

    # 找共同 model
    pairs = []
    for v9_p in v9_rank:
        v8_p = aliases.get(v9_p, v9_p)
        if v8_p in v8_rank:
            pairs.append((v9_p, v8_rank[v8_p], v9_rank[v9_p]))
    if not pairs:
        # alt: substring match
        for v9_p in v9_rank:
            for v8_p in v8_rank:
                if v9_p.split()[0] in v8_p or v8_p.split()[0] in v9_p:
                    pairs.append((v9_p, v8_rank[v8_p], v9_rank[v9_p]))
                    break

    fig, ax = plt.subplots(figsize=(11, 8))
    for name, v8_r, v9_r in pairs:
        delta = v8_r - v9_r
        if delta > 2: color = C_GREEN  # 升
        elif delta < -2: color = C_RED  # 跌
        else: color = C_GRAY  # 平
        ax.annotate("",
                    xy=(2, v9_r),
                    xytext=(1, v8_r),
                    arrowprops=dict(arrowstyle="->", color=color, lw=2, alpha=0.85))
        ax.text(0.95, v8_r, name, ha="right", va="center", fontsize=10, color=TEXT_MAIN)
        ax.text(2.05, v9_r, f"#{v9_r}", ha="left", va="center",
                fontsize=10, fontweight="bold", color=color, family='monospace')

    ax.set_xticks([1, 2])
    ax.set_xticklabels(["V8\n(245 分制 · audit 主观)", "V9\n(24 题 · ground truth)"],
                       fontsize=11, color=TEXT_MAIN)
    ax.set_ylim(max([x[1] for x in pairs] + [x[2] for x in pairs]) + 1, 0)
    ax.set_yticks([])
    ax.set_title('八九轮测试之"牛马"——"学霸"大反转',
                 fontsize=15, fontweight="bold", pad=14, color=TEXT_MAIN)
    for s in ['top', 'right', 'left']:
        ax.spines[s].set_visible(False)
    ax.spines['bottom'].set_color(BORDER)

    legend = [
        mpatches.Patch(color=C_GREEN, label="排名升 (≥3 位)"),
        mpatches.Patch(color=C_RED, label="排名跌 (≥3 位)"),
        mpatches.Patch(color=C_GRAY, label="排名平 (±2 位)"),
    ]
    ax.legend(handles=legend, loc="upper right", fontsize=9,
              facecolor=PANEL, edgecolor=BORDER, labelcolor=TEXT_MAIN)
    plt.tight_layout()
    out = CHARTS_DIR / "v9-vs-v8.png"
    plt.savefig(out, dpi=180, facecolor=BG, bbox_inches='tight')
    plt.close()
    print(f"  ✓ {out.name}")


# ─── 图 4 · Qwen3.6 三部署对比 ───
def render_qwen_deployment(agg):
    targets = ["Qwen3.6-A3B (Spark)", "Qwen3.6-Plus", "Qwen3.6-27B (4090)"]
    labels = ["Spark NVFP4\n(35B-A3B)", "Qwen-Plus\n(官方 API)", "4090 vLLM\n(27B FP8)"]

    fields_disp = ["数学", "物理", "化学", "生物", "长ctx", "编程", "医学", "金融"]
    fields_key = ["math", "physics", "chemistry", "biology", "longctx", "code_algo", "medical", "finance"]

    matrix = []
    totals = []
    for p in targets:
        sd = agg.get(p, {})
        row = []
        for s in fields_key:
            c, t = sd.get(s, (0, 0))
            row.append(c if t else np.nan)
        matrix.append(row)
        tc, tt, pct = get_total_pct(sd)
        totals.append((tc, tt, pct))
    matrix = np.array(matrix)

    fig, ax = plt.subplots(figsize=(12, 5.5))
    x = np.arange(len(fields_disp))
    width = 0.27
    colors = [C_GREEN, C_ORANGE, C_RED]  # Spark 强 / Plus 中 / 4090 弱
    for i, (lbl, total) in enumerate(zip(labels, totals)):
        ax.bar(x + (i - 1) * width, matrix[i], width,
               label=f"{lbl}  {total[0]}/{total[1]} = {total[2]:.1f}%",
               color=colors[i], edgecolor=BORDER, linewidth=0.6, alpha=0.9)

    ax.set_xticks(x)
    ax.set_xticklabels(fields_disp, fontsize=11, color=TEXT_MAIN)
    ax.set_yticks(range(0, 4))
    ax.set_yticklabels([str(i) for i in range(0, 4)], color=TEXT_DIM)
    ax.set_ylabel("子分(满 3)", fontsize=10, color=TEXT_DIM)
    ax.set_title("Qwen 3.6 三部署同模型实测 · 部署影响放大到学霸 vs 牛马差",
                 fontsize=14, fontweight="bold", pad=14, color=TEXT_MAIN)
    ax.legend(fontsize=10, loc="upper right",
              facecolor=PANEL, edgecolor=BORDER, labelcolor=TEXT_MAIN)
    ax.grid(axis="y", alpha=0.2, color=BORDER, linestyle='--')
    ax.set_axisbelow(True)
    ax.set_ylim(0, 3.7)
    for spine in ax.spines.values():
        spine.set_edgecolor(BORDER)
    plt.tight_layout()
    out = CHARTS_DIR / "qwen3-deployment.png"
    plt.savefig(out, dpi=180, facecolor=BG, bbox_inches='tight')
    plt.close()
    print(f"  ✓ {out.name}")


def main():
    print("Loading V9 data...")
    agg = load_v9_data()
    print(f"  loaded {len(agg)} providers")
    print()
    print(f"Rendering to {CHARTS_DIR}/")
    render_leaderboard(agg)
    render_heatmap(agg)
    render_v8_vs_v9(agg)
    render_qwen_deployment(agg)
    print()
    print("✓ Done. Charts in:", CHARTS_DIR)


if __name__ == "__main__":
    main()
