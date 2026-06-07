/**
 * Observe-only corpus harvester — mines persisted session .jsonl transcripts for assistant
 * turns that contain malformed / pseudo tool-call syntax, and emits a LABELED JSONL corpus.
 *
 * Read-only. Touches NO live path. Uses shared/pseudo-tool-call.ts `scanPseudoToolMarkers`
 * purely to LABEL (which wrong-tool-call shapes appear + counts). This deliberately does NOT
 * use / re-enable the suppression API (containsPseudoToolSimulation / stripPseudoToolCallMarkup),
 * which v0.79.3 intentionally turned into pass-throughs. A false positive in this corpus is
 * harmless — you filter at curation time; it never alters product behavior.
 *
 * Use case: build a corpus of "how model X (e.g. Step-3.7 Flash) writes tool-calls wrong",
 * tagged by model, for fine-tuning / DPO negatives / detector regression tests.
 *
 * Run:
 *   node --import tsx scripts/harvest-pseudo-tool-corpus.ts \
 *     --in ~/.lynn --in ~/.claude/projects \
 *     --out reports/pseudo_tool_corpus.jsonl \
 *     [--model flash]            # case-insensitive substring filter on the model id
 *     [--max-text 16000] [--quiet]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanPseudoToolMarkers } from "../shared/pseudo-tool-call.js";

type Args = { in: string[]; out: string; model: string | null; maxText: number; quiet: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { in: [], out: "reports/pseudo_tool_corpus.jsonl", model: null, maxText: 16000, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--in") a.in.push(expand(argv[++i]));
    else if (t === "--out") a.out = expand(argv[++i]);
    else if (t === "--model") a.model = (argv[++i] || "").toLowerCase();
    else if (t === "--max-text") a.maxText = Math.max(200, parseInt(argv[++i] || "16000", 10) || 16000);
    else if (t === "--quiet") a.quiet = true;
  }
  if (!a.in.length) a.in = [expand("~/.lynn")];
  return a;
}

function expand(p: string | undefined): string {
  if (!p) return "";
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield full;
  }
}

function extractAssistantText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c && (c.type === "text" || typeof c.text === "string"))
    .map((c: any) => String(c.text || ""))
    .join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const outAbs = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const sink = fs.createWriteStream(outAbs, { flags: "w" });

  let files = 0, turns = 0, hits = 0;
  const perModel = new Map<string, number>();
  const perPattern = new Map<string, number>();

  for (const root of args.in) {
    for (const file of walkJsonl(root)) {
      files++;
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(file, "utf-8").split("\n");
      } catch {
        continue;
      }
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        let obj: any;
        try {
          obj = JSON.parse(s);
        } catch {
          continue;
        }
        const msg = obj?.message;
        if (!msg || msg.role !== "assistant") continue;
        turns++;
        const text = extractAssistantText(msg);
        if (!text) continue;
        const model = String(msg.model || obj.model || "unknown");
        if (args.model && !model.toLowerCase().includes(args.model)) continue;
        const scan = scanPseudoToolMarkers(text);
        if (scan.total <= 0) continue;
        hits++;
        perModel.set(model, (perModel.get(model) || 0) + 1);
        for (const p of scan.patterns) perPattern.set(p.name, (perPattern.get(p.name) || 0) + p.count);
        const record = {
          ts: obj.timestamp || null,
          model,
          session: path.basename(file),
          uuid: obj.uuid || null,
          total: scan.total,
          patterns: scan.patterns,
          text: text.length > args.maxText ? text.slice(0, args.maxText) + "…[truncated]" : text,
        };
        sink.write(JSON.stringify(record) + "\n");
      }
    }
  }
  sink.end();

  if (!args.quiet) {
    const sortDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    process.stderr.write(`\n=== pseudo-tool corpus harvest ===\n`);
    process.stderr.write(`scanned: ${files} files · ${turns} assistant turns · ${hits} turns with pseudo-tool markup\n`);
    process.stderr.write(`output : ${outAbs}\n`);
    if (args.model) process.stderr.write(`filter : model contains "${args.model}"\n`);
    process.stderr.write(`\n-- hits per model --\n`);
    for (const [m, n] of sortDesc(perModel)) process.stderr.write(`  ${n.toString().padStart(5)}  ${m}\n`);
    process.stderr.write(`\n-- counts per wrong-tool-call pattern --\n`);
    for (const [p, n] of sortDesc(perPattern)) process.stderr.write(`  ${n.toString().padStart(5)}  ${p}\n`);
    process.stderr.write(`\n`);
  }
  process.stdout.write(JSON.stringify({ files, turns, hits, out: outAbs }) + "\n");
}

main();
