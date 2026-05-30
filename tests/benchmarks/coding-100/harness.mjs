#!/usr/bin/env node
// Lynn coding-100 — 多语言执行验证 coding benchmark(10 语言 × 10 题,4 硬 + 6 极难,全执行验证)。
// 题库:problems/*.mjs(每条 { id, lang, prompt, test, canonical })。详见 README.md。
// 运行:
//   SELFTEST=1 node harness.mjs                         # 用 canonical 自检 harness/断言链路(应 100/100)
//   API_KEY=... API_BASE=... MODEL=... node harness.mjs # 评测任一 OpenAI 兼容模型 → results.json
// 本机依赖(需可执行):python3 / node / g++ / rustc / go / bash;SQL 走 python 内置 sqlite3;
//   TS 需 typescript、CSS/HTML 校验需 jsdom + css-tree(在本目录 `npm i typescript jsdom css-tree`)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const env = (...keys) => { for (const k of keys) if (process.env[k]) return process.env[k]; return ''; };
// 端点:OpenAI 兼容。优先 API_*,兼容 STEPFUN_* 别名。
const KEY = env('API_KEY', 'STEPFUN_KEY');
const BASE = env('API_BASE', 'STEPFUN_BASE') || 'https://api.openai.com/v1';
const MODEL = env('MODEL', 'STEPFUN_MODEL') || 'gpt-4o';
const EFFORT = env('REASONING_EFFORT', 'STEPFUN_REASONING_EFFORT') || 'high';
const MAXTOK = parseInt(env('MAX_TOKENS', 'STEPFUN_MAX_TOKENS') || '32768', 10);
const SEND_EFFORT = env('SEND_REASONING_EFFORT') !== '0'; // 非 reasoning 模型可设 SEND_REASONING_EFFORT=0
const CONC = parseInt(process.env.CONC || '4', 10);
const OUT = process.env.OUT || path.join(SCRIPT_DIR, 'results.json');
const PROBDIR = process.env.PROBDIR || path.join(SCRIPT_DIR, 'problems');
const NODE = process.execPath;
const CT = process.env.CBENCH_NODE_MODULES || path.join(SCRIPT_DIR, 'node_modules'); // jsdom + css-tree
const RUSTC = process.env.RUSTC || 'rustc';
const GO = process.env.GO || 'go';
const TSC = process.env.TSC || path.join(SCRIPT_DIR, 'node_modules', '.bin', 'tsc');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));

const NODEDIR = path.dirname(process.execPath);
function run(cmd, opts = {}) { return execSync(cmd, { timeout: opts.to || 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: NODEDIR + ':' + (process.env.PATH || '/usr/bin:/bin'), ...(opts.env || {}) }, cwd: opts.cwd }); }
function pass(out) { return String(out).includes('__PASS__'); }

// 去掉模型可能多写的 package/import/main 干扰(各语言按需)
function stripGo(c) { return c.replace(/^\s*package\s+\w+.*$/gm, '').replace(/^\s*import\s*\([\s\S]*?\)/m, '').replace(/^\s*import\s+"[^"]*".*$/gm, ''); }

function runProblem(p, code) {
  const d = fs.mkdtempSync(path.join(TMP, p.id + '-'));
  const f = (n) => path.join(d, n);
  try {
    switch (p.lang) {
      case 'python': {
        fs.writeFileSync(f('s.py'), code + '\n\n' + p.test + '\nprint("__PASS__")\n');
        return pass(run(`python3 ${f('s.py')}`));
      }
      case 'javascript': {
        fs.writeFileSync(f('s.cjs'), code + '\n\n(function(){const _m=module.exports||{};Object.assign(globalThis,_m);\n' + p.test + '\nconsole.log("__PASS__");})();\n');
        return pass(run(`${NODE} ${f('s.cjs')}`));
      }
      case 'cpp': {
        fs.writeFileSync(f('s.cpp'), '#include <bits/stdc++.h>\nusing namespace std;\n' + code + '\nint main(){\n' + p.test + '\nprintf("__PASS__\\n");return 0;}\n');
        run(`g++ -O2 -std=c++17 ${f('s.cpp')} -o ${f('s.out')}`, { to: 40000 });
        return pass(run(f('s.out')));
      }
      case 'rust': {
        fs.writeFileSync(f('s.rs'), code + '\nfn main(){\n' + p.test + '\nprintln!("__PASS__");\n}\n');
        run(`${RUSTC} -O --edition 2021 ${f('s.rs')} -o ${f('s.out')}`, { to: 60000 });
        return pass(run(f('s.out')));
      }
      case 'go': {
        fs.writeFileSync(f('go.mod'), 'module s\ngo 1.21\n');
        fs.writeFileSync(f('main.go'), 'package main\nimport ("fmt";"os")\nvar _=os.Exit\n' + stripGo(code) + '\nfunc main(){\n' + p.test + '\nfmt.Println("__PASS__")\n}\n');
        return pass(run(`${GO} run .`, { cwd: d, to: 90000, env: { GOCACHE: TMP + '/gocache', GOPATH: TMP + '/gopath', GOFLAGS: '-mod=mod' } }));
      }
      case 'typescript': {
        fs.writeFileSync(f('s.ts'), code + '\n\n' + p.test + '\nconsole.log("__PASS__");\n');
        run(`${TSC} --target es2022 --module commonjs --skipLibCheck --outDir ${d} ${f('s.ts')}`, { to: 60000 });
        return pass(run(`${NODE} ${f('s.js')}`));
      }
      case 'sql': {
        // p.test = {schema, query_check}; 模型产出的是 SQL query(code)。用 python sqlite3 跑。
        const spec = JSON.parse(p.test);
        const py = [
          'import sqlite3,json',
          'con=sqlite3.connect(":memory:");cur=con.cursor()',
          'cur.executescript(' + JSON.stringify(spec.schema) + ')',
          'q=' + JSON.stringify(code),
          'rows=[list(r) for r in cur.execute(q).fetchall()]',
          'exp=' + JSON.stringify(spec.expect),
          'assert rows==exp, ("GOT:"+json.dumps(rows)+" EXP:"+json.dumps(exp))',
          'print("__PASS__")',
        ].join('\n');
        fs.writeFileSync(f('s.py'), py);
        return pass(run(`python3 ${f('s.py')}`));
      }
      case 'bash': {
        fs.writeFileSync(f('s.sh'), code + '\n');
        // p.test = bash 断言:运行 s.sh 得到输出后校验,通过则 echo __PASS__
        fs.writeFileSync(f('t.sh'), 'set -e\nOUT="$(bash ' + f('s.sh') + ')"\n' + p.test + '\necho __PASS__\n');
        return pass(run(`bash ${f('t.sh')}`));
      }
      case 'css': {
        const v = `const csstree=require(${JSON.stringify(CT + '/css-tree')});const css=require('fs').readFileSync(${JSON.stringify(f('s.css'))},'utf8');const ast=csstree.parse(css);const RULES=[];const MEDIA=[];csstree.walk(ast,{visit:'Atrule',enter(n){if(n.name==='media'&&n.prelude)MEDIA.push(csstree.generate(n.prelude));}});csstree.walk(ast,{visit:'Rule',enter(n){const sel=csstree.generate(n.prelude);const dd={};n.block.children.forEach(c=>{if(c.type==='Declaration')dd[c.property.toLowerCase()]=csstree.generate(c.value).trim();});RULES.push({sel,decls:dd});}});function rule(s){return RULES.find(r=>r.sel.includes(s));}function decl(s,p){const r=rule(s);return r?r.decls[p]:undefined;}\n${p.test}\nconsole.log('__PASS__');`;
        fs.writeFileSync(f('s.css'), code);
        fs.writeFileSync(f('v.cjs'), v);
        return pass(run(`${NODE} ${f('v.cjs')}`));
      }
      case 'html': {
        const v = `const {JSDOM}=require(${JSON.stringify(CT + '/jsdom')});const html=require('fs').readFileSync(${JSON.stringify(f('s.html'))},'utf8');const doc=new JSDOM(html).window.document;const $=s=>doc.querySelector(s);const $$=s=>[...doc.querySelectorAll(s)];\n${p.test}\nconsole.log('__PASS__');`;
        fs.writeFileSync(f('s.html'), code);
        fs.writeFileSync(f('v.cjs'), v);
        return pass(run(`${NODE} ${f('v.cjs')}`));
      }
      default: return false;
    }
  } catch (e) { return false; }
}

function extractCode(text, lang) {
  if (!text) return '';
  const fences = [...text.matchAll(/```[a-zA-Z+#]*\n([\s\S]*?)```/g)].map(m => m[1]);
  if (fences.length) return fences.sort((a, b) => b.length - a.length)[0];
  return text;
}

async function callModel(prompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 420000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], ...(SEND_EFFORT ? { reasoning_effort: EFFORT } : {}), max_tokens: MAXTOK, stream: false }),
    });
    const d = await r.json();
    if (d.error) return { content: '', err: JSON.stringify(d.error).slice(0, 150) };
    const m = d.choices?.[0]?.message || {};
    return { content: m.content || '', reasoning: (m.reasoning_content || m.reasoning || '').length, usage: d.usage };
  } catch (e) { return { content: '', err: String(e.message) }; }
  finally { clearTimeout(t); }
}

async function loadProblems() {
  const all = [];
  for (const fn of fs.readdirSync(PROBDIR).filter(x => x.endsWith('.mjs')).sort()) {
    const mod = await import('file://' + path.join(PROBDIR, fn));
    for (const p of (mod.default || [])) all.push(p);
  }
  return all;
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function main() {
  const SELFTEST = process.env.SELFTEST === '1';
  const P = await loadProblems();
  const rows = await pool(P, SELFTEST ? 8 : CONC, async (p) => {
    const t0 = Date.now();
    if (SELFTEST) {
      let ok = false, note = '';
      try { ok = runProblem(p, p.canonical || ''); note = ok ? 'PASS' : 'CANON-FAIL'; } catch (e) { note = 'harness:' + String(e.message).slice(0, 60); }
      return { id: p.id, lang: p.lang, pass: ok, note };
    }
    const res = await callModel(p.prompt);
    let ok = false, note = '';
    if (res.err) note = 'api:' + res.err;
    else if (!res.content.trim()) note = `empty(reasoning=${res.reasoning}c)`;
    else { try { ok = runProblem(p, extractCode(res.content, p.lang)); note = ok ? 'PASS' : 'exec-fail'; } catch (e) { note = 'harness:' + String(e.message).slice(0, 50); } }
    return { id: p.id, lang: p.lang, pass: ok, note, secs: (Date.now() - t0) / 1000 | 0, ctok: res.usage?.completion_tokens ?? null };
  });
  const byLang = {};
  for (const r of rows) { byLang[r.lang] = byLang[r.lang] || [0, 0]; byLang[r.lang][1]++; if (r.pass) byLang[r.lang][0]++; }
  rows.forEach(r => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} (${r.lang}) ${r.note}`));
  const total = rows.filter(r => r.pass).length;
  const summary = { total: `${total}/${rows.length}`, byLang: Object.fromEntries(Object.entries(byLang).map(([k, v]) => [k, `${v[0]}/${v[1]}`])) };
  if (!SELFTEST) fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, effort: SEND_EFFORT ? EFFORT : null, max_tokens: MAXTOK, summary, rows }, null, 2));
  console.log('\n=== ' + (SELFTEST ? 'SELFTEST' : 'effort=' + EFFORT) + ' ===\n总计', summary.total, '| 分语言', JSON.stringify(summary.byLang));
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
