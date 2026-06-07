#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const cli = path.join(repo, "cli/bin/lynn.mjs");
const outDir = path.join(repo, "output");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-toolchain-stress-"));
const reportPath = path.join(outDir, `cli-toolchain-stress-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const maxSteps = process.env.LYNN_CLI_TOOLCHAIN_MAX_STEPS || "20";
const timeoutMs = Number(process.env.LYNN_CLI_TOOLCHAIN_TIMEOUT_MS || 180000);
const tsBin = path.join(repo, "node_modules/.bin/tsc");

fs.mkdirSync(outDir, { recursive: true });

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function run(cmd, args, cwd, timeout = timeoutMs) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      LYNN_CLI_UPDATE_CHECK: "0",
    },
  });
  return {
    code: result.status,
    signal: result.signal || null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function sh(command, cwd, timeout = 30000) {
  return run("/bin/zsh", ["-lc", command], cwd, timeout);
}

function parseEvents(stdout) {
  const events = [];
  const nonJson = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      nonJson.push(line);
    }
  }
  return { events, nonJson };
}

function eventText(events) {
  return events
    .map((event) => event.text || event.delta || event.message || event.content || event.final || "")
    .filter(Boolean)
    .join("");
}

function toolSummary(events) {
  const requested = [];
  const results = [];
  const names = [];
  for (const event of events) {
    const type = String(event.type || "");
    const state = String(event.event || "");
    if (type.includes("tool") && (type.includes("requested") || state === "start")) requested.push(event);
    if (type.includes("tool") && (type.includes("result") || state === "end")) results.push(event);
    const name = event.name || event.tool || event.toolName || event.request?.name || event.result?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return { requested: requested.length, results: results.length, names };
}

const scenarios = [
  {
    id: "py-median-bug",
    setup(dir) {
      write(
        path.join(dir, "stats.py"),
        `def median(xs):\n    xs = sorted(xs)\n    n = len(xs)\n    if n == 0:\n        raise ValueError('empty')\n    return xs[n // 2]\n`,
      );
      write(
        path.join(dir, "test_stats.py"),
        `from stats import median\nassert median([1]) == 1\nassert median([1, 3, 5]) == 3\nassert median([1, 2, 3, 4]) == 2.5\nassert median([4, 1, 2, 3]) == 2.5\nprint('ALL_PASS')\n`,
      );
    },
    prompt: "Fix stats.py median for even-length lists. Read files first, make the smallest edit, then run python3 test_stats.py.",
    verify: (dir) => sh("python3 test_stats.py", dir),
  },
  {
    id: "js-async-foreach",
    setup(dir) {
      write(
        path.join(dir, "queue.js"),
        `async function processItems(items, worker) {\n  const out = [];\n  items.forEach(async (item) => {\n    out.push(await worker(item));\n  });\n  return out;\n}\nmodule.exports = { processItems };\n`,
      );
      write(
        path.join(dir, "test.js"),
        `const { processItems } = require('./queue');\n(async () => {\n  const seen = [];\n  const out = await processItems([1, 2, 3], async (x) => {\n    await new Promise((resolve) => setTimeout(resolve, 5));\n    seen.push(x);\n    return x * 2;\n  });\n  if (JSON.stringify(out) !== JSON.stringify([2, 4, 6])) throw new Error('bad out ' + JSON.stringify(out));\n  if (JSON.stringify(seen) !== JSON.stringify([1, 2, 3])) throw new Error('bad seen ' + JSON.stringify(seen));\n  console.log('ALL_PASS');\n})();\n`,
      );
    },
    prompt: "Fix the async forEach bug in queue.js while preserving order. Run node test.js until it prints ALL_PASS.",
    verify: (dir) => sh("node test.js", dir),
  },
  {
    id: "js-csv-quotes",
    setup(dir) {
      write(path.join(dir, "parse.js"), `function parseLine(line) {\n  return line.split(',');\n}\nmodule.exports = { parseLine };\n`);
      write(
        path.join(dir, "test.js"),
        `const { parseLine } = require('./parse');\nconst got = parseLine('a,\"b,c\",d,\"e\"\"f\"');\nconst want = ['a', 'b,c', 'd', 'e\"f'];\nif (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('got ' + JSON.stringify(got));\nconsole.log('ALL_PASS');\n`,
      );
    },
    prompt: "Fix parse.js CSV parsing for quoted commas and doubled quote escaping. Run node test.js.",
    verify: (dir) => sh("node test.js", dir),
  },
  {
    id: "ts-cross-file-rename",
    setup(dir) {
      write(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "CommonJS", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2));
      write(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: `${tsBin} -p tsconfig.json` } }, null, 2));
      write(path.join(dir, "src/types.ts"), `export interface User { id: string; name: string; }\n`);
      write(path.join(dir, "src/format.ts"), `import type { User } from './types';\nexport function label(user: User): string { return user.id + ':' + user.name.toUpperCase(); }\n`);
      write(path.join(dir, "src/index.ts"), `import { label } from './format';\nimport type { User } from './types';\nconst users: User[] = [{ id: 'u1', name: 'Ada' }, { id: 'u2', name: 'Linus' }];\nconsole.log(users.map(label).join(','));\n`);
    },
    prompt: "Cross-file refactor: rename User.name to User.displayName and update every usage. Do not leave any name field. Run npm run typecheck.",
    verify(dir) {
      const typecheck = sh("npm run typecheck", dir, 60000);
      if (typecheck.code !== 0) return typecheck;
      const grep = sh('! grep -R "name" -n src', dir);
      return grep.code === 0 ? typecheck : { code: 1, signal: null, stdout: typecheck.stdout + grep.stdout, stderr: `${typecheck.stderr}${grep.stderr}\nname remains` };
    },
  },
  {
    id: "ts-signature-pointfree",
    setup(dir) {
      write(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "CommonJS", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2));
      write(path.join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: `${tsBin} -p tsconfig.json` } }, null, 2));
      write(path.join(dir, "src/types.ts"), `export interface User { id: string; displayName: string; }\n`);
      write(
        path.join(dir, "src/format.ts"),
        `import type { User } from './types';\nexport function formatUser(user: User, uppercase = false): string {\n  const text = user.id + ':' + user.displayName;\n  return uppercase ? text.toUpperCase() : text;\n}\n`,
      );
      write(path.join(dir, "src/report.ts"), `import { formatUser } from './format';\nimport type { User } from './types';\nexport function report(users: User[]): string[] {\n  return users.map(formatUser);\n}\n`);
      write(path.join(dir, "src/index.ts"), `import { formatUser } from './format';\nconst u = { id: 'u1', displayName: 'Ada' };\nconsole.log(formatUser(u, true));\n`);
    },
    prompt: "Refactor formatUser to formatUser({ user, uppercase }) and update all call sites. Be careful with the point-free users.map(formatUser) callback in report.ts. Run npm run typecheck.",
    verify: (dir) => sh("npm run typecheck", dir, 60000),
  },
  {
    id: "py-lru-implementation",
    setup(dir) {
      write(path.join(dir, "lru.py"), `class LRUCache:\n    def __init__(self, capacity):\n        self.capacity = capacity\n\n    def get(self, key):\n        return -1\n\n    def put(self, key, value):\n        pass\n`);
      write(
        path.join(dir, "test_lru.py"),
        `from lru import LRUCache\nc = LRUCache(2)\nc.put('a', 1); c.put('b', 2)\nassert c.get('a') == 1\nc.put('c', 3)\nassert c.get('b') == -1\nassert c.get('c') == 3\nc.put('a', 9)\nassert c.get('a') == 9\nc.put('d', 4)\nassert c.get('c') == -1\nprint('ALL_PASS')\n`,
      );
    },
    prompt: "Implement LRUCache in lru.py. Evict the least recently used item when capacity is exceeded. Run python3 test_lru.py.",
    verify: (dir) => sh("python3 test_lru.py", dir),
  },
  {
    id: "js-deep-merge",
    setup(dir) {
      write(path.join(dir, "merge.js"), `function deepMerge(a, b) {\n  return { ...a, ...b };\n}\nmodule.exports = { deepMerge };\n`);
      write(
        path.join(dir, "test.js"),
        `const assert = require('node:assert/strict');\nconst { deepMerge } = require('./merge');\nconst a = { api: { retries: 1, headers: { a: 'x' } }, list: [1], keep: true };\nconst b = { api: { timeout: 30, headers: { b: 'y' } }, list: [2] };\nconst got = deepMerge(a, b);\nconst want = { api: { retries: 1, timeout: 30, headers: { a: 'x', b: 'y' } }, list: [2], keep: true };\nassert.deepStrictEqual(got, want);\nassert.deepStrictEqual(a, { api: { retries: 1, headers: { a: 'x' } }, list: [1], keep: true });\nconsole.log('ALL_PASS');\n`,
      );
    },
    prompt: "Fix deepMerge so it recursively merges plain objects, arrays are replaced by the right-hand side, and inputs are not mutated. Run node test.js.",
    verify: (dir) => sh("node test.js", dir),
  },
  {
    id: "bash-safe-script",
    setup(dir) {
      write(path.join(dir, "count_ext.sh"), `#!/usr/bin/env bash\nset -euo pipefail\n# TODO count files by extension under first arg\necho done\n`);
      fs.chmodSync(path.join(dir, "count_ext.sh"), 0o755);
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      write(path.join(dir, "data/a.ts"), "");
      write(path.join(dir, "data/b.ts"), "");
      write(path.join(dir, "data/c.js"), "");
      write(path.join(dir, "data/README"), "");
      write(
        path.join(dir, "test.sh"),
        `#!/usr/bin/env bash\nset -euo pipefail\nout=$(./count_ext.sh data | sort)\nexpected=$'.js 1\n.ts 2\n[none] 1'\n[[ "$out" == "$expected" ]] || { echo "$out"; exit 1; }\necho ALL_PASS\n`,
      );
      fs.chmodSync(path.join(dir, "test.sh"), 0o755);
    },
    prompt: 'Implement count_ext.sh: count regular files by extension under the given directory. Files without extensions should be "[none] N". Run ./test.sh.',
    verify: (dir) => sh("./test.sh", dir),
  },
  {
    id: "ts-generic-groupby",
    setup(dir) {
      write(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2020", module: "CommonJS", outDir: "dist" }, include: ["src/**/*.ts"] }, null, 2));
      write(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: `${tsBin} -p tsconfig.json && node dist/test.js` } }, null, 2));
      write(path.join(dir, "src/groupBy.ts"), `export function groupBy(items: any[], key: string): any {\n  return {};\n}\n`);
      write(
        path.join(dir, "src/test.ts"),
        `import { groupBy } from './groupBy';\nconst rows = [{ team: 'a', score: 1 }, { team: 'b', score: 2 }, { team: 'a', score: 3 }] as const;\nconst grouped = groupBy(rows, (x) => x.team);\nif (grouped.a.length !== 2 || grouped.b[0].score !== 2) throw new Error('bad group');\nconsole.log('ALL_PASS');\n`,
      );
    },
    prompt: "Implement a type-safe generic groupBy(items, keyFn) in src/groupBy.ts returning Record<PropertyKey, T[]>. Run npm test.",
    verify: (dir) => sh("npm test", dir, 60000),
  },
  {
    id: "py-toposort-cycle",
    setup(dir) {
      write(path.join(dir, "topo.py"), `def topo_sort(edges):\n    return []\n`);
      write(
        path.join(dir, "test_topo.py"),
        `from topo import topo_sort\norder = topo_sort([('build', 'test'), ('lint', 'test'), ('test', 'deploy')])\npos = {x: i for i, x in enumerate(order)}\nassert pos['build'] < pos['test'] < pos['deploy']\nassert pos['lint'] < pos['test']\ntry:\n    topo_sort([('a', 'b'), ('b', 'a')])\n    raise AssertionError('cycle not detected')\nexcept ValueError:\n    pass\nprint('ALL_PASS')\n`,
      );
    },
    prompt: "Implement topo_sort(edges) in topo.py. Return a valid topological order and raise ValueError on cycles. Run python3 test_topo.py.",
    verify: (dir) => sh("python3 test_topo.py", dir),
  },
  {
    id: "js-token-bucket",
    setup(dir) {
      write(
        path.join(dir, "bucket.js"),
        `class TokenBucket {\n  constructor(capacity, refillPerSecond, now = () => Date.now() / 1000) {\n    this.capacity = capacity; this.refillPerSecond = refillPerSecond; this.now = now; this.tokens = 0;\n  }\n  take(n = 1) { return false; }\n}\nmodule.exports = { TokenBucket };\n`,
      );
      write(
        path.join(dir, "test.js"),
        `const { TokenBucket } = require('./bucket');\nlet t = 0;\nconst b = new TokenBucket(5, 2, () => t);\nif (!b.take(1)) throw new Error('initial should be full');\nif (!b.take(4)) throw new Error('capacity spend');\nif (b.take(1)) throw new Error('empty');\nt += 1.5;\nif (!b.take(3)) throw new Error('refilled 3');\nif (b.take(1)) throw new Error('empty again');\nt += 10;\nif (!b.take(5)) throw new Error('capped at capacity');\nif (b.take(1)) throw new Error('over capacity');\nconsole.log('ALL_PASS');\n`,
      );
    },
    prompt: "Implement the token bucket limiter. It starts full and refills over time up to capacity. Run node test.js.",
    verify: (dir) => sh("node test.js", dir),
  },
  {
    id: "py-context-manager",
    setup(dir) {
      write(path.join(dir, "timer.py"), `class capture_duration:\n    pass\n`);
      write(
        path.join(dir, "test_timer.py"),
        `import time\nfrom timer import capture_duration\nwith capture_duration() as d:\n    time.sleep(0.02)\nassert d.seconds >= 0.015, d.seconds\nassert isinstance(d.millis, int) and d.millis >= 15\nprint('ALL_PASS')\n`,
      );
    },
    prompt: "Implement capture_duration as a Python context manager exposing seconds and millis after the with block exits. Run python3 test_timer.py.",
    verify: (dir) => sh("python3 test_timer.py", dir),
  },
  {
    id: "js-hidden-validation",
    setup(dir) {
      write(path.join(dir, "slug.js"), `function slugify(s) {\n  return s.toLowerCase().replaceAll(' ', '-');\n}\nmodule.exports = { slugify };\n`);
      write(
        path.join(dir, "test.js"),
        `const { slugify } = require('./slug');\nconst cases = [\n  ['Hello, World!', 'hello-world'],\n  ['  多  语言 -- Test  ', '多-语言-test'],\n  ['A&B/C', 'a-b-c'],\n  ['already---ok', 'already-ok'],\n];\nfor (const [input, want] of cases) {\n  const got = slugify(input);\n  if (got !== want) throw new Error(input + ' -> ' + got + ' want ' + want);\n}\nconsole.log('ALL_PASS');\n`,
      );
    },
    prompt: "Fix slugify: lowercase, remove punctuation, collapse whitespace/separators to one dash, keep Chinese, and trim edge dashes. Run node test.js.",
    verify: (dir) => sh("node test.js", dir),
  },
];

const selected = process.env.LYNN_CLI_TOOLCHAIN_CASES
  ? new Set(process.env.LYNN_CLI_TOOLCHAIN_CASES.split(",").map((item) => item.trim()).filter(Boolean))
  : null;
const limit = Number(process.env.LYNN_CLI_TOOLCHAIN_LIMIT || 0);
const queue = scenarios
  .filter((scenario) => !selected || selected.has(scenario.id))
  .slice(0, limit > 0 ? limit : undefined);

if (!queue.length) {
  throw new Error("No toolchain stress scenarios selected");
}

const results = [];
for (const [index, scenario] of queue.entries()) {
  const dir = path.join(root, `${String(index + 1).padStart(2, "0")}-${scenario.id}`);
  fs.mkdirSync(dir, { recursive: true });
  scenario.setup(dir);
  const prompt = `${scenario.prompt}\nRequirement: actually read/edit files and run the verification command before the final answer.`;
  const args = [
    "code",
    "-p",
    prompt,
    "--json",
    "--cwd",
    dir,
    "--approval",
    "yolo",
    "--sandbox",
    "danger-full-access",
    "--reasoning",
    "high",
    "--max-steps",
    maxSteps,
    "--save-session",
  ];
  const start = Date.now();
  process.stdout.write(`[${index + 1}/${queue.length}] ${scenario.id} ... `);
  const cliResult = run(process.execPath, [cli, ...args], repo, timeoutMs);
  const elapsedMs = Date.now() - start;
  const parsed = parseEvents(cliResult.stdout);
  const verify = scenario.verify(dir);
  const tools = toolSummary(parsed.events);
  const pass = cliResult.code === 0 && verify.code === 0;
  write(path.join(dir, "lynn-stdout.jsonl"), cliResult.stdout);
  write(path.join(dir, "lynn-stderr.txt"), cliResult.stderr);
  console.log(`${pass ? "PASS" : "FAIL"} cli=${cliResult.code} verify=${verify.code} tools=${tools.requested}/${tools.results} ${elapsedMs}ms`);
  results.push({
    id: scenario.id,
    pass,
    workspace: dir,
    rawStdoutPath: path.join(dir, "lynn-stdout.jsonl"),
    rawStderrPath: path.join(dir, "lynn-stderr.txt"),
    cli: {
      code: cliResult.code,
      signal: cliResult.signal,
      elapsedMs,
      stderrTail: cliResult.stderr.slice(-5000),
      nonJsonTail: parsed.nonJson.slice(-40),
      finalTextTail: eventText(parsed.events).slice(-5000),
      toolSummary: tools,
      eventTypes: [...new Set(parsed.events.map((event) => event.type).filter(Boolean))],
    },
    verify: {
      code: verify.code,
      signal: verify.signal,
      stdout: verify.stdout.slice(-5000),
      stderr: verify.stderr.slice(-5000),
    },
  });
}

const report = {
  root,
  reportPath,
  total: results.length,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
  results,
};
write(reportPath, JSON.stringify(report, null, 2));
console.log(`REPORT ${reportPath}`);
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, root, reportPath }, null, 2));
