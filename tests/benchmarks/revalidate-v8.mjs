#!/usr/bin/env node
/**
 * Re-validate V8 cloud results — fix T15 (correct answer = 17, not 23).
 * Reads each provider's results.json, re-runs validation on T15, updates ok/errors.
 */
import fs from "node:fs";
import path from "node:path";

if (process.argv.length < 3) {
  console.error("usage: revalidate-v8.mjs <batch_dir>");
  process.exit(1);
}

const batchDir = process.argv[2];
const T15_RE = /(?:\bn\s*=\s*17\b|\\boxed\{?17\}?|=\s*17\b|为\s*17\b|17\s*[，,。.]|17\s*$)/m;
// 重判 too_short:阈值从 80 → 20(题目本身可能要求短答)
const TOO_SHORT_THRESHOLD = 20;

let totalFlipped = 0;
for (const sub of fs.readdirSync(batchDir)) {
  const fp = path.join(batchDir, sub, "results.json");
  if (!fs.existsSync(fp)) continue;
  const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
  let flipped = 0;
  for (const r of data.results) {
    if (r.http_error) continue;
    let changed = false;
    // T15 数学答案
    if (r.id === "T15") {
      const hasMathErr = (r.errors || []).includes("math_answer_wrong");
      const correct = T15_RE.test(r.raw || "");
      if (hasMathErr && correct) {
        r.errors = r.errors.filter((e) => e !== "math_answer_wrong");
        changed = true;
      } else if (!hasMathErr && !correct) {
        r.errors = [...(r.errors || []), "math_answer_wrong"];
        changed = true;
      }
    }
    // too_short 重判(阈值 20,放过短答题)
    const hasTooShort = (r.errors || []).includes("too_short");
    const tooShort = (r.raw || "").length < TOO_SHORT_THRESHOLD;
    if (hasTooShort && !tooShort) {
      r.errors = r.errors.filter((e) => e !== "too_short");
      changed = true;
    } else if (!hasTooShort && tooShort) {
      r.errors = [...(r.errors || []), "too_short"];
      changed = true;
    }
    if (changed) {
      const wasOk = r.ok;
      r.ok = r.errors.length === 0;
      if (wasOk !== r.ok) {
        flipped++;
        if (r.ok) { data.pass++; data.fail--; } else { data.pass--; data.fail++; }
      }
    }
  }
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  console.log(`  ${sub}: ${flipped} T15 flipped (now pass=${data.pass}/${data.total})`);
  totalFlipped += flipped;
}
console.log(`Total flipped: ${totalFlipped}`);
