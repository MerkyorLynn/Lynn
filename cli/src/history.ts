/**
 * history.ts — persistent input history for the interactive code REPL.
 * Stored as plain lines in ~/.lynn/cli-history (most-recent last). Best-effort:
 * history is never critical, so all fs errors are swallowed. HistoryNavigator is
 * a pure cursor (testable) used by the raw-mode reader for ↑/↓ navigation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX = 500;

export function historyPath(home: string = os.homedir()): string {
  return path.join(home, ".lynn", "cli-history");
}

export function loadHistory(file: string = historyPath(), max = MAX): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-max);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string, file: string = historyPath(), max = MAX): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  try {
    const entries = loadHistory(file, max);
    if (entries[entries.length - 1] === trimmed) return; // skip consecutive duplicates
    entries.push(trimmed);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${entries.slice(-max).join("\n")}\n`, "utf8");
  } catch {
    /* best-effort: history is non-critical */
  }
}

/** Cursor over history entries (most-recent last). `prev` = older (↑), `next` = newer (↓). */
export class HistoryNavigator {
  private cursor: number;

  constructor(private readonly entries: string[]) {
    this.cursor = entries.length;
  }

  prev(current: string): string {
    if (this.cursor > 0) this.cursor -= 1;
    return this.entries[this.cursor] ?? current;
  }

  next(): string {
    if (this.cursor < this.entries.length) this.cursor += 1;
    return this.entries[this.cursor] ?? "";
  }
}
