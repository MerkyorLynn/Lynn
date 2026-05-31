import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { completeSlash } from "./completion.js";
import { HistoryNavigator } from "./history.js";
import { renderInputBand } from "./tui-input.js";
import { supportsColor } from "./terminal-style.js";
import { terminalTuiProfile } from "./terminal-safety.js";

export interface InteractiveLineMode {
  approval: "ask" | "on-failure" | "never" | "yolo";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

export interface InteractiveLineOptions {
  placeholder?: string;
  history?: HistoryNavigator;
  completions?: string[];
  onShiftTab?: () => string | void;
}

export async function readInteractiveLine(
  prompt: string,
  _mode: InteractiveLineMode,
  options: InteractiveLineOptions = {},
): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output, terminal: false });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  if (shouldUseNativeLineInput()) {
    return readNativeTerminalLine(prompt, options);
  }

  const rawBefore = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return await new Promise<string | null>((resolve) => {
    let buffer = "";
    const color = supportsColor(output);
    const placeholder = options.placeholder || "";
    const clearWidth = () => Math.max(80, typeof output.columns === "number" ? output.columns : 0, prompt.length + buffer.length + placeholder.length + 8);
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(rawBefore);
      input.pause();
    };
    const redraw = () => {
      output.write(`\r${" ".repeat(clearWidth())}\r${renderInputBand({ prompt, value: buffer, placeholder, width: clearWidth(), color })}`);
      if (!buffer && placeholder) output.write(`\r${prompt}`);
    };
    redraw();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const newlineIndex = text.search(/[\r\n]/);
      if (newlineIndex >= 0) {
        const beforeNewline = text.slice(0, newlineIndex);
        const printableBeforeNewline = Array.from(beforeNewline).filter((char) => char >= " " && char !== "\u007f").join("");
        buffer += printableBeforeNewline;
        output.write(`\r${" ".repeat(clearWidth())}\r${renderInputBand({ prompt, value: buffer, width: clearWidth(), color })}\n`);
        cleanup();
        resolve(buffer);
        return;
      }
      if (text === "\u0003") {
        output.write(`\r${" ".repeat(clearWidth())}\r^C\n`);
        cleanup();
        resolve(null);
        return;
      }
      if (text === "\u0004") {
        output.write(`\r${" ".repeat(clearWidth())}\r\n`);
        cleanup();
        resolve(null);
        return;
      }
      if (text === "\u001b[Z") {
        const message = options.onShiftTab?.();
        if (message) output.write(`\n${message}`);
        redraw();
        return;
      }
      if (text === "\u007f" || text === "\b") {
        if (buffer.length) {
          buffer = Array.from(buffer).slice(0, -1).join("");
          redraw();
        }
        return;
      }
      if (text === "\u001b[A" && options.history) {
        buffer = options.history.prev(buffer);
        redraw();
        return;
      }
      if (text === "\u001b[B" && options.history) {
        buffer = options.history.next();
        redraw();
        return;
      }
      if (text === "\t" && options.completions) {
        const completion = completeSlash(buffer, options.completions);
        if (completion.matches.length > 1) output.write(`\n${completion.matches.join("  ")}\n`);
        buffer = completion.completed;
        redraw();
        return;
      }
      if (text.startsWith("\u001b")) return;
      const printable = Array.from(text).filter((char) => char >= " " && char !== "\u007f").join("");
      if (!printable) return;
      buffer += printable;
      redraw();
    };
    input.on("data", onData);
  });
}

export function shouldUseNativeLineInput(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LYNN_CLI_APPLE_TERMINAL_RAW_INPUT === "1") return false;
  const profile = terminalTuiProfile(env);
  return profile.appleTerminal && !profile.animation;
}

async function readNativeTerminalLine(prompt: string, options: InteractiveLineOptions): Promise<string | null> {
  const width = Math.max(80, typeof output.columns === "number" ? output.columns : 0);
  const color = supportsColor(output);
  output.write(`${renderInputBand({ prompt: "", value: "", width, color })}\r`);
  const rl = readline.createInterface({
    input,
    output,
    terminal: true,
    completer: options.completions
      ? (line: string) => {
          const completion = completeSlash(line, options.completions || []);
          return [completion.matches.length ? completion.matches : [], line] as [string[], string];
        }
      : undefined,
  });
  try {
    return await rl.question(prompt);
  } catch {
    return null;
  } finally {
    rl.close();
  }
}
