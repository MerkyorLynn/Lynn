import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { brightCyan, bold, dim, orange, supportsColor, yellow } from "./terminal-style.js";
import { visibleLength } from "./startup.js";
import { completeSlash, looksLikeSlashCommand, normalizeSlashInput } from "./completion.js";
import { HistoryNavigator } from "./history.js";
import { analyzePastedContext, normalizePastedText, summarizePastedContext } from "./pasted-context.js";
import { t } from "./i18n.js";

const ESC = "\x1b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export interface BoxedInputOptions {
  status?: string;
  placeholder?: string;
  history?: HistoryNavigator;
  completions?: string[];
  onShiftTab?: () => string | void;
  danger?: boolean;
}

export interface BoxRender {
  top: string;
  inputLine: string;
  paletteLines: string[];
  bottom: string;
  cursorCol: number;
  rowsBelowInput: number;
}

const COLLAPSE_CHARS = 120;

function charWidth(ch: string): number {
  return Math.max(1, visibleLength(ch));
}

export function summarizeInputForBox(buffer: string): string | null {
  const normalized = normalizePastedText(buffer);
  if (!normalized.includes("\n") && Array.from(normalized).length <= COLLAPSE_CHARS) return null;
  const info = analyzePastedContext(normalized);
  const summary = summarizePastedContext(info) || `${Array.from(normalized).length} 字符`;
  return `↪ 粘贴块 · ${summary}`;
}

function clampWidth(width: number): number {
  return Math.max(28, Math.min(width || 80, 110));
}

function truncateToWidth(text: string, max: number): string {
  if (visibleLength(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of Array.from(text)) {
    const cw = charWidth(ch);
    if (used + cw > max - 1) break;
    out += ch;
    used += cw;
  }
  return `${out}…`;
}

function slashCommandLabel(command: string): string {
  const key = command.split(/\s+/)[0];
  switch (key) {
    case "/model":
      return t("slash.label.model");
    case "/providers":
    case "/byok":
    case "/setup":
      return t("slash.label.providers");
    case "/mode":
      return t("slash.label.mode");
    case "/yolo":
      return t("slash.label.yolo");
    case "/ask":
      return t("slash.label.ask");
    case "/fast":
      return t("slash.label.fast");
    case "/think":
    case "/reasoning":
      return t("slash.label.think");
    case "/help":
      return t("slash.label.help");
    case "/exit":
      return t("slash.label.exit");
    case "/tools":
      return t("slash.label.tools");
    case "/clear":
      return t("slash.label.clear");
    case "/image":
    case "/images":
    case "/attach":
      return t("slash.label.image");
    default:
      return "";
  }
}

function visibleCompletions(commands: string[]): string[] {
  return commands.filter((command) => command !== "/quit" && command !== "/tool");
}

function slashMatches(input: string, commands: string[] | undefined): string[] {
  const normalized = normalizeSlashInput(input);
  if (!commands?.length || !looksLikeSlashCommand(normalized) || normalized.includes("\n")) return [];
  return completeSlash(normalized, visibleCompletions(commands)).matches;
}

function renderSlashPalette(input: string, commands: string[] | undefined, maxWidth: number, color: boolean, selected = 0): string[] {
  const normalized = normalizeSlashInput(input);
  const visible = commands?.length ? visibleCompletions(commands) : [];
  if (!visible.length || !looksLikeSlashCommand(normalized) || normalized.includes("\n")) return [];
  const completion = completeSlash(normalized, visible);
  if (!completion.matches.length) return [yellow(t("slash.unknown"), color)];

  const rows: string[] = [];
  const sel = Math.max(0, Math.min(selected, completion.matches.length - 1));
  const start = Math.max(0, Math.min(sel - 5, completion.matches.length - 6));
  const shown = completion.matches.slice(start, start + 6);
  for (let i = 0; i < shown.length; i += 1) {
    const command = shown[i];
    const label = slashCommandLabel(command);
    const active = start + i === sel;
    const prefix = active ? brightCyan("›", color) : dim(`${start + i + 1}.`, color);
    const name = active ? bold(brightCyan(command, color), color) : brightCyan(command, color);
    const row = `${prefix} ${name}${label ? dim(`  ${label}`, color) : ""}`;
    rows.push(truncateToWidth(row, maxWidth));
  }
  rows.push(dim(truncateToWidth(t("slash.moreHint"), maxWidth), color));
  return rows;
}

function renderSlashHint(input: string, commands: string[] | undefined, maxWidth: number, color: boolean): string {
  const normalized = normalizeSlashInput(input);
  const visible = commands?.length ? visibleCompletions(commands) : [];
  if (!visible.length || !normalized.startsWith("/") || normalized.includes("\n")) return "";
  const completion = completeSlash(normalized, visible);
  if (!completion.matches.length) return "";
  const suffix = completion.completed.length > normalized.length ? completion.completed.slice(normalized.length) : "";
  if (suffix) return dim(truncateToWidth(`${suffix}  ${t("slash.tabHint")}`, maxWidth), color);
  if (completion.matches.length === 1) {
    const command = completion.matches[0];
    const label = slashCommandLabel(command);
    return dim(truncateToWidth(label ? ` ${label}` : "", maxWidth), color);
  }
  return "";
}

export function renderInputBox(opts: {
  status: string;
  buffer: string;
  cursor: number;
  width: number;
  color: boolean;
  placeholder?: string;
  completions?: string[];
  selected?: number;
  danger?: boolean;
}): BoxRender {
  const { status, buffer, cursor, color } = opts;
  const danger = !!opts.danger;
  const border = (text: string) => danger ? orange(text, color) : dim(text, color);
  const chevron = danger ? orange("›", color) : brightCyan("›", color);
  const w = clampWidth(opts.width);
  const textArea = w - 6;
  const collapsed = summarizeInputForBox(buffer);
  const renderBuffer = collapsed || buffer;
  const slashHint = collapsed ? "" : renderSlashHint(buffer, opts.completions, Math.max(0, textArea - visibleLength(buffer)), color);
  const chars = Array.from(renderBuffer);

  const starts: number[] = [];
  let acc = 0;
  for (const ch of chars) {
    starts.push(acc);
    acc += charWidth(ch);
  }
  const hintCols = visibleLength(slashHint);
  const totalCols = acc + hintCols;
  let beforeCursor = 0;
  const renderCursor = collapsed ? chars.length : cursor;
  for (let i = 0; i < renderCursor && i < chars.length; i += 1) beforeCursor += charWidth(chars[i]);

  let winStart = 0;
  if (totalCols > textArea) winStart = Math.max(0, beforeCursor - textArea + 1);

  const empty = !collapsed && chars.length === 0;
  let visibleText = "";
  let used = 0;
  if (empty && opts.placeholder) {
    for (const ch of Array.from(opts.placeholder)) {
      const cw = charWidth(ch);
      if (used + cw > textArea) break;
      visibleText += ch;
      used += cw;
    }
    visibleText = dim(visibleText, color);
  } else {
    for (let i = 0; i < chars.length; i += 1) {
      const c0 = starts[i];
      const cw = charWidth(chars[i]);
      if (c0 < winStart) continue;
      if (c0 - winStart + cw > textArea - hintCols) break;
      visibleText += chars[i];
      used += cw;
    }
    if (slashHint && used + hintCols <= textArea) {
      visibleText += slashHint;
      used += hintCols;
    }
  }
  const pad = " ".repeat(Math.max(0, textArea - used));

  const left = `${border("│")} ${chevron} `;
  const right = ` ${border("│")}`;
  const inputLine = `${left}${visibleText}${pad}${right}`;
  const cursorCol = 4 + (empty ? 0 : beforeCursor - winStart);
  const palette = collapsed ? [] : renderSlashPalette(buffer, opts.completions, textArea, color, opts.selected);
  const paletteLines = palette.map((row) => {
    return `${border("│")}   ${row}${" ".repeat(Math.max(0, textArea - visibleLength(row)))} ${border("│")}`;
  });

  const rawLabel = ` ${truncateToWidth(status, w - 7)} `;
  const fill = Math.max(2, w - 3 - visibleLength(rawLabel));
  const top = `${border("╭─")}${bold(rawLabel, color)}${border("─".repeat(fill) + "╮")}`;
  const bottom = border(`╰${"─".repeat(w - 2)}╯`);

  return { top, inputLine, paletteLines, bottom, cursorCol, rowsBelowInput: 1 + paletteLines.length };
}

export async function readBoxedInputLine(options: BoxedInputOptions = {}): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output, terminal: false });
    try {
      return await rl.question("› ");
    } finally {
      rl.close();
    }
  }

  const color = supportsColor(output);
  const status = options.status || "";
  const placeholder = options.placeholder || "";
  let buf: string[] = [];
  let cur = 0;
  let selected = 0;
  const value = () => buf.join("");
  const width = () => Math.max(28, Math.min((typeof output.columns === "number" ? output.columns : 80) - 1, 110));

  const rawBefore = input.isRaw;
  input.setRawMode(true);
  input.resume();
  output.write(`${ESC}[?2004h`);

  const render = () => renderInputBox({ status, buffer: value(), cursor: cur, width: width(), color, placeholder, completions: options.completions, selected, danger: options.danger });
  const toCol = (col: number) => (col > 0 ? `${ESC}[${col}C` : "");
  let painted = false;
  let rowsBelowInput = 1;

  const paint = (clear = false) => {
    const r = render();
    if (painted && clear) output.write(`${ESC}[1A\r${ESC}[J`);
    else output.write("\r");
    output.write(`${r.top}\r\n${r.inputLine}\r\n`);
    for (const line of r.paletteLines) output.write(`${line}\r\n`);
    output.write(r.bottom);
    output.write(`${ESC}[${r.rowsBelowInput}A\r${toCol(r.cursorCol)}`);
    rowsBelowInput = r.rowsBelowInput;
    painted = true;
  };
  const redrawInput = () => {
    paint(true);
  };
  const printAbove = (message: string) => {
    output.write(`${ESC}[1A\r${ESC}[J${message}\n`);
    paint();
  };
  const leaveBelow = (tail = "") => {
    output.write(`${ESC}[${rowsBelowInput}B\r\n${tail}`);
  };

  return await new Promise<string | null>((resolve) => {
    const cleanup = () => {
      input.off("data", onData);
      output.write(`${ESC}[?2004l`);
      input.setRawMode(rawBefore);
      input.pause();
    };
    const insert = (text: string) => {
      const printable = Array.from(normalizePastedText(text)).filter((ch) => ch === "\n" || (ch >= " " && ch !== "\x7f"));
      if (!printable.length) return;
      buf.splice(cur, 0, ...printable);
      cur += printable.length;
      selected = 0;
      redrawInput();
    };
    const selectCompletion = (matches: string[]) => {
      buf = Array.from(matches[Math.max(0, Math.min(selected, matches.length - 1))] + " ");
      cur = buf.length;
      selected = 0;
      redrawInput();
    };
    let pasteBuffer: string | null = null;
    const consumePaste = (text: string): boolean => {
      if (pasteBuffer !== null) {
        const end = text.indexOf(PASTE_END);
        if (end >= 0) {
          pasteBuffer += text.slice(0, end);
          insert(pasteBuffer);
          pasteBuffer = null;
          const rest = text.slice(end + PASTE_END.length);
          if (rest) onData(Buffer.from(rest));
          return true;
        }
        pasteBuffer += text;
        return true;
      }
      const start = text.indexOf(PASTE_START);
      if (start < 0) return false;
      const before = text.slice(0, start);
      const afterStart = text.slice(start + PASTE_START.length);
      if (before) insert(before);
      const end = afterStart.indexOf(PASTE_END);
      if (end >= 0) {
        insert(afterStart.slice(0, end));
        const rest = afterStart.slice(end + PASTE_END.length);
        if (rest) onData(Buffer.from(rest));
      } else {
        pasteBuffer = afterStart;
      }
      return true;
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");

      if (consumePaste(text)) return;

      const nl = text.search(/[\r\n]/);
      if (nl >= 0) {
        const newlineCount = (text.match(/[\r\n]/g) || []).length;
        const beforeText = text.slice(0, nl);
        const afterText = text.slice(nl + 1);
        const looksLikePaste = newlineCount > 1 || !!afterText.trim() || Array.from(beforeText).length > COLLAPSE_CHARS;
        if (looksLikePaste) {
          insert(normalizePastedText(text));
          return;
        }
        const before = Array.from(text.slice(0, nl)).filter((ch) => ch >= " " && ch !== "\x7f");
        if (before.length) { buf.splice(cur, 0, ...before); cur += before.length; selected = 0; }
        const matches = slashMatches(value(), options.completions);
        if (matches.length && !matches.includes(normalizeSlashInput(value()))) {
          selectCompletion(matches);
          return;
        }
        leaveBelow();
        cleanup();
        resolve(value());
        return;
      }
      if (text === "\x03") { leaveBelow(color ? `${dim("^C", color)}\n` : "^C\n"); cleanup(); resolve(null); return; }
      if (text === "\x04") { if (!buf.length) { leaveBelow(); cleanup(); resolve(null); } return; }
      if (text === `${ESC}[Z`) {
        const message = options.onShiftTab?.();
        if (message) printAbove(message.replace(/\n+$/, ""));
        else redrawInput();
        return;
      }
      if (text === "\x7f" || text === "\b") {
        if (cur > 0) { buf.splice(cur - 1, 1); cur -= 1; selected = 0; redrawInput(); }
        return;
      }
      if (text === `${ESC}[D`) { cur = Math.max(0, cur - 1); redrawInput(); return; }
      if (text === `${ESC}[C`) { cur = Math.min(buf.length, cur + 1); redrawInput(); return; }
      if (text === `${ESC}[H` || text === "\x01") { cur = 0; redrawInput(); return; }
      if (text === `${ESC}[F` || text === "\x05") { cur = buf.length; redrawInput(); return; }
      if (text === `${ESC}[A` || text === `${ESC}[B`) {
        const matches = slashMatches(value(), options.completions);
        if (matches.length) {
          selected = (selected + (text === `${ESC}[A` ? -1 : 1) + matches.length) % matches.length;
          redrawInput();
        } else if (options.history) {
          buf = Array.from(text === `${ESC}[A` ? options.history.prev(value()) : options.history.next());
          cur = buf.length;
          selected = 0;
          redrawInput();
        }
        return;
      }
      if (text === "\t" && options.completions) {
        const matches = slashMatches(value(), options.completions);
        if (matches.length) selectCompletion(matches);
        return;
      }
      if (text.startsWith(ESC)) return;
      insert(text);
    };

    input.on("data", onData);
    paint();
  });
}
