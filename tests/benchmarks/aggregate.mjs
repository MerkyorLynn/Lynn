#!/usr/bin/env node
/**
 * Aggregator — 读 V9 + V8 cloud batch results,出排名表 + 失败模式
 *
 * Usage:
 *   node tests/benchmarks/aggregate.mjs --v9 v9-comprehensive/results/batch-<ts> --v8 output/v8-cloud-batch-<ts>
 *   node tests/benchmarks/aggregate.mjs --auto   # 自动找最新两个 batch dir
 */
import fs from "node:fs";
import path from "node:path";

const args = (() => {
  const a = { v9: "", v8: "", out: "", auto: false };
  for (let i = 2; i < process.argv.length; i++) {
    const x = process.argv[i];
    if (x === "--v9") a.v9 = process.argv[++i];
    else if (x === "--v8") a.v8 = process.argv[++i];
    else if (x === "--out") a.out = process.argv[++i];
    else if (x === "--auto") a.auto = true;
  }
  return a;
})();

const BENCH_DIR = path.dirname(new URL(import.meta.url).pathname);

function findLatest(parent, prefix) {
  if (!fs.existsSync(parent)) return null;
  const dirs = fs.readdirSync(parent, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => path.join(parent, d.name))
    .sort();
  return dirs.at(-1) || null;
}

if (args.auto) {
  args.v9 = args.v9 || findLatest(path.join(BENCH_DIR, "v9-comprehensive/results"), "batch-");
  args.v8 = args.v8 || findLatest(path.join(BENCH_DIR, "output"), "v8-cloud-batch-");
}

if (!args.v9 || !args.v8) {
  console.error("Need --v9 <dir> --v8 <dir> or --auto");
  process.exit(1);
}

const V9_DIM_ORDER = ["math", "physics", "chemistry", "biology", "longctx", "code_algo", "medical", "finance"];
const V9_EXCLUDED = new Set(["sql"]); // verifier 太严格,不计入总分
const PROVIDER_EXCLUDED = new Set([
  "Qwen3.6-Plus",        // DashScope 余额耗尽
  "Step-3.5-Flash",      // Step Star 套餐到期
  "Gemini 2.5 Pro",      // Google 模型留 3.x 系列即可
  "Gemini 2.5 Flash",    // 同上
]);

// ── Load V9 ──
function loadV9(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || !f.startsWith("v9_")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      if (PROVIDER_EXCLUDED.has(data.provider)) continue;
      const ssScore = data.subset_score || {};
      const ssTotal = data.subset_total || {};
      const total = Object.entries(ssTotal).reduce((a, [k, v]) => a + (V9_EXCLUDED.has(k) ? 0 : v), 0);
      const correct = Object.entries(ssScore).reduce((a, [k, v]) => a + (V9_EXCLUDED.has(k) ? 0 : v), 0);
      const allHttpErr = (data.results || []).every((r) =>
        r.runs?.[0]?.error?.startsWith("HTTP 4") || r.runs?.[0]?.error?.startsWith("HTTP 5"));
      out[data.provider] = {
        provider: data.provider,
        model: data.model,
        total, correct,
        pct: total ? +((100 * correct) / total).toFixed(1) : 0,
        subsets: Object.fromEntries(V9_DIM_ORDER.map((d) => [d, [ssScore[d] || 0, ssTotal[d] || 0]])),
        sql: [ssScore["sql"] || 0, ssTotal["sql"] || 0],
        results: data.results || [],
        invalid: allHttpErr,
      };
    } catch (e) {
      console.error(`[skip] ${f}: ${e.message}`);
    }
  }
  return out;
}

// ── Load V8 ──
function loadV8(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const sub of fs.readdirSync(dir)) {
    const fp = path.join(dir, sub, "results.json");
    if (!fs.existsSync(fp)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      if (PROVIDER_EXCLUDED.has(data.provider)) continue;
      const allHttpErr = (data.results || []).every((r) => r.http_error);
      out[data.provider] = {
        provider: data.provider, model: data.model,
        total: data.total, pass: data.pass, fail: data.fail,
        pct: data.total ? +((100 * data.pass) / data.total).toFixed(1) : 0,
        results: data.results || [],
        invalid: allHttpErr,
      };
    } catch (e) {
      console.error(`[skip] ${fp}: ${e.message}`);
    }
  }
  return out;
}

const v9Data = loadV9(args.v9);
const v8Data = loadV8(args.v8);

const allProviders = [...new Set([...Object.keys(v9Data), ...Object.keys(v8Data)])].sort();

// ── 综合排名(V9 pct × 0.6 + V8 pct × 0.4)·invalid 家排末尾 ──
const ranked = allProviders.map((p) => {
  const v9 = v9Data[p];
  const v8 = v8Data[p];
  const invalid = (v9?.invalid && v8?.invalid) || (v9?.invalid && !v8) || (v8?.invalid && !v9);
  const v9pct = v9 && !v9.invalid ? v9.pct : null;
  const v8pct = v8 && !v8.invalid ? v8.pct : null;
  const composite = (v9pct != null && v8pct != null) ? +(v9pct * 0.6 + v8pct * 0.4).toFixed(1) : null;
  return {
    provider: p,
    v9: v9 ? (v9.invalid ? `(invalid)` : `${v9.correct}/${v9.total} (${v9pct}%)`) : "—",
    v9pct, v9data: v9,
    v8: v8 ? (v8.invalid ? `(invalid)` : `${v8.pass}/${v8.total} (${v8pct}%)`) : "—",
    v8pct, v8data: v8,
    composite, invalid,
  };
}).sort((a, b) => {
  if (a.invalid && !b.invalid) return 1;
  if (!a.invalid && b.invalid) return -1;
  return (b.composite ?? -1) - (a.composite ?? -1);
});

// ── 失败模式分类 ──
function v8FailModes(v8) {
  const m = new Map();
  if (!v8?.results) return [];
  for (const r of v8.results) {
    if (r.ok) continue;
    for (const e of (r.errors || ["unknown"])) m.set(e, (m.get(e) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function v9FailDims(v9) {
  if (!v9?.subsets) return [];
  return V9_DIM_ORDER.map((d) => {
    const [c, t] = v9.subsets[d] || [0, 0];
    return { d, c, t, pct: t ? +((100 * c) / t).toFixed(0) : 0 };
  });
}

// ── Markdown report ──
const lines = [];
lines.push(`# Lynn V9+V8 横评报告`);
lines.push(`生成时间: ${new Date().toLocaleString("zh-CN")}`);
lines.push(`V9 batch: \`${args.v9}\``);
lines.push(`V8 batch: \`${args.v8}\``);
lines.push(``);
lines.push(`## 综合排名(V9 × 0.6 + V8 × 0.4)`);
lines.push(``);
lines.push(`| 排名 | 模型 | V9 (24题, ground-truth) | V8 (30题, 启发式) | 综合 |`);
lines.push(`|---|---|---|---|---|`);
ranked.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.provider} | ${r.v9} | ${r.v8} | ${r.composite != null ? r.composite + "%" : "—"} |`);
});

lines.push(``);
lines.push(`## V9 详细维度(每维 3 题 · sql 因 verifier 严格不计入总分)`);
lines.push(``);
lines.push(`| 模型 | math | physics | chem | bio | longctx | code | medical | finance | 总分 (24) | sql* |`);
lines.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
const v9Sorted = [...ranked].filter((r) => r.v9data && !r.v9data.invalid).sort((a, b) => (b.v9pct ?? -1) - (a.v9pct ?? -1));
v9Sorted.forEach((r) => {
  const ds = v9FailDims(r.v9data);
  const cells = ds.map((d) => `${d.c}/${d.t}`).join(" | ");
  const sql = r.v9data.sql ? `${r.v9data.sql[0]}/${r.v9data.sql[1]}` : "—";
  lines.push(`| ${r.provider} | ${cells} | **${r.v9data.correct}/${r.v9data.total} (${r.v9pct}%)** | ${sql} |`);
});

lines.push(``);
lines.push(`## V8 失败模式(top 5/家)`);
lines.push(``);
const v8Sorted = [...ranked].filter((r) => r.v8data).sort((a, b) => (b.v8pct ?? -1) - (a.v8pct ?? -1));
for (const r of v8Sorted) {
  const fm = v8FailModes(r.v8data);
  const top = fm.slice(0, 5).map(([k, v]) => `${k}=${v}`).join(", ") || "(全过)";
  lines.push(`- **${r.provider}** ${r.v8} · 失败:${top}`);
}

lines.push(``);
lines.push(`## V8 题目矩阵(每行一道题,每列一家,✓/✗/—)`);
lines.push(``);
const allV8Ids = (() => {
  const s = new Set();
  for (const p of Object.values(v8Data)) for (const r of p.results || []) s.add(r.id);
  return [...s];
})();
const v8Cols = v8Sorted.map((r) => r.provider);
lines.push(`| 题号 | ` + v8Cols.join(" | ") + " |");
lines.push(`|---|` + v8Cols.map(() => "---").join("|") + "|");
for (const id of allV8Ids) {
  const cells = v8Cols.map((p) => {
    const r = v8Data[p]?.results?.find((x) => x.id === id);
    if (!r) return "—";
    return r.ok ? "✓" : "✗";
  });
  lines.push(`| ${id} | ` + cells.join(" | ") + " |");
}

lines.push(``);
lines.push(`---`);
lines.push(`总 inference: V9 ${Object.values(v9Data).reduce((a, p) => a + (p.total || 0), 0)} + V8 ${Object.values(v8Data).reduce((a, p) => a + (p.total || 0), 0)}`);

const outPath = args.out || path.join(BENCH_DIR, `report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
fs.writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Saved: ${outPath}`);
console.log(`\nQuick summary (composite rank):`);
ranked.slice(0, 12).forEach((r, i) => {
  console.log(`  ${(i + 1).toString().padStart(2)}. ${r.provider.padEnd(28)}  V9 ${(r.v9pct ?? "—").toString().padStart(5)} · V8 ${(r.v8pct ?? "—").toString().padStart(5)} · 综合 ${(r.composite ?? "—")}`);
});
