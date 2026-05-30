import React from "react";
import { Box, Text } from "ink";
import { highlightCodeLine } from "./code-highlight.js";

export type InkMarkdownLine =
  | { kind: "heading"; text: string }
  | { kind: "bullet"; indent: string; text: string }
  | { kind: "numbered"; indent: string; number: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "fence"; open: boolean; lang?: string }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "blank" }
  | { kind: "text"; text: string };

export type InkInlineSegment =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "link"; text: string; url: string };

export function parseInkMarkdown(text: string): InkMarkdownLine[] {
  const lines = text.split(/\r?\n/);
  const parsed: InkMarkdownLine[] = [];
  let inFence = false;
  let fenceLang: string | undefined;
  for (const raw of lines) {
    const fence = /^\s*```(.*)$/.exec(raw);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? (fence[1]?.trim() || undefined) : undefined;
      parsed.push({ kind: "fence", open: inFence, lang: fenceLang });
      continue;
    }
    if (inFence) {
      parsed.push({ kind: "code", text: raw, lang: fenceLang });
      continue;
    }
    if (!raw) {
      parsed.push({ kind: "blank" });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      parsed.push({ kind: "heading", text: stripStrongMarkers(heading[1] || "") });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      parsed.push({ kind: "bullet", indent: bullet[1] || "", text: bullet[2] || "" });
      continue;
    }
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
    if (numbered) {
      parsed.push({ kind: "numbered", indent: numbered[1] || "", number: numbered[2] || "1", text: numbered[3] || "" });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      parsed.push({ kind: "quote", text: quote[1] || "" });
      continue;
    }
    parsed.push({ kind: "text", text: raw });
  }
  return parsed;
}

export function parseInkInline(text: string): InkInlineSegment[] {
  const out: InkInlineSegment[] = [];
  const pattern = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*([^*\n]+)\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push({ kind: "text", text: text.slice(cursor, index) });
    if (match[2] !== undefined) out.push({ kind: "code", text: match[2] });
    else if (match[4] !== undefined) out.push({ kind: "bold", text: match[4] });
    else if (match[6] !== undefined) out.push({ kind: "strike", text: match[6] });
    else if (match[8] !== undefined) out.push({ kind: "link", text: match[8], url: match[9] ?? "" });
    else if (match[11] !== undefined) out.push({ kind: "italic", text: match[11] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out.length ? out : [{ kind: "text", text }];
}

export function classifyDiffLine(line: string): "add" | "remove" | "hunk" | "meta" | "context" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |\*\*\* |╭|┌|└)/.test(line)) return "meta";
  return "context";
}

export function InkMarkdown({ text, error = false, maxLines = 80 }: { text: string; error?: boolean; maxLines?: number }): React.ReactElement {
  const lines = parseInkMarkdown(text).slice(0, maxLines);
  return React.createElement(Box, { flexDirection: "column" },
    ...lines.map((line, index) => renderMarkdownLine(line, index, error)),
  );
}

export function InkDiffText({ text, maxLines = 32 }: { text: string; maxLines?: number }): React.ReactElement {
  return React.createElement(Box, { flexDirection: "column" },
    ...text.split(/\r?\n/).slice(0, maxLines).map((line, index) => {
      const kind = classifyDiffLine(line);
      const color = kind === "add" ? "green" : kind === "remove" ? "red" : kind === "hunk" ? "cyan" : "gray";
      return React.createElement(Text, { key: index, color }, line || " ");
    }),
  );
}

function renderMarkdownLine(line: InkMarkdownLine, key: number, error: boolean): React.ReactElement {
  if (error) return React.createElement(Text, { key, color: "red" }, line.kind === "blank" ? " " : lineText(line));
  if (line.kind === "blank") return React.createElement(Text, { key }, " ");
  if (line.kind === "heading") return React.createElement(Text, { key, color: "cyan", bold: true }, line.text);
  if (line.kind === "quote") return React.createElement(Text, { key, color: "gray" }, `▏ ${line.text}`);
  if (line.kind === "fence") return React.createElement(Text, { key, color: "gray" }, line.open ? `┌─${line.lang ? ` ${line.lang}` : ""}` : "└─");
  if (line.kind === "code") return renderDiffAwareCodeLine(line.text, key, line.lang);
  if (line.kind === "bullet") {
    return React.createElement(Text, { key }, line.indent,
      React.createElement(Text, { color: "cyan" }, "•"),
      " ",
      ...renderInline(line.text),
    );
  }
  if (line.kind === "numbered") {
    return React.createElement(Text, { key }, `${line.indent}${line.number}. `, ...renderInline(line.text));
  }
  return React.createElement(Text, { key }, ...renderInline(line.text));
}

function renderDiffAwareCodeLine(text: string, key: number, lang?: string): React.ReactElement {
  const isDiffLang = lang === "diff" || lang === "patch";
  const kind = classifyDiffLine(text);
  // Diff-color for explicit diff/patch blocks, or unlabeled blocks that look like
  // a diff. A real language always syntax-highlights (so `-1` in JS stays code).
  if (isDiffLang || (!lang && kind !== "context")) {
    const color = kind === "add" ? "green" : kind === "remove" ? "red" : kind === "hunk" ? "cyan" : "gray";
    return React.createElement(Text, { key, color }, text || " ");
  }
  if (!text) return React.createElement(Text, { key }, " ");
  return React.createElement(Text, { key },
    ...highlightCodeLine(text, lang).map((seg, i) =>
      React.createElement(Text, { key: i, color: seg.color }, seg.text),
    ),
  );
}

function renderInline(text: string): React.ReactElement[] {
  return parseInkInline(text).map((segment, index) => {
    if (segment.kind === "code") return React.createElement(Text, { key: index, color: "cyan" }, segment.text);
    if (segment.kind === "bold") return React.createElement(Text, { key: index, bold: true }, segment.text);
    if (segment.kind === "italic") return React.createElement(Text, { key: index, italic: true }, segment.text);
    if (segment.kind === "strike") return React.createElement(Text, { key: index, strikethrough: true }, segment.text);
    if (segment.kind === "link") {
      return React.createElement(Text, { key: index },
        React.createElement(Text, { color: "cyan", underline: true }, segment.text),
        React.createElement(Text, { dimColor: true }, ` (${segment.url})`),
      );
    }
    return React.createElement(Text, { key: index }, segment.text);
  });
}

function lineText(line: InkMarkdownLine): string {
  if (line.kind === "blank") return "";
  if (line.kind === "fence") return line.open ? `┌─${line.lang ? ` ${line.lang}` : ""}` : "└─";
  if (line.kind === "bullet") return `${line.indent}• ${line.text}`;
  if (line.kind === "numbered") return `${line.indent}${line.number}. ${line.text}`;
  if (line.kind === "quote") return `▏ ${line.text}`;
  return line.text;
}

function stripStrongMarkers(text: string): string {
  return text.replace(/\*\*/g, "");
}
