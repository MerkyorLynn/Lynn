import React from "react";
import { Box, Text, useStdout } from "ink";
import { completeSlash, normalizeSlashInput } from "./completion.js";
import { t } from "./i18n.js";
import { visibleLength } from "./startup.js";

export interface InkInputLineProps {
  value: string;
  placeholder: string;
  danger?: boolean;
  commands?: string[];
  contextSummary?: string;
}

export function InkInputLine({ value, placeholder, danger, commands = [], contextSummary = "" }: InkInputLineProps): React.ReactElement {
  const { stdout } = useStdout();
  const prompt = "› ";
  const width = Math.max(20, (stdout.columns || 80) - 2);
  const hint = slashHint(value, commands, width - visibleLength(prompt));
  const palette = slashPalette(value, commands);
  const visibleText = value || placeholder;
  const multiline = value.includes("\n");
  const rawWidth = visibleLength(`${prompt}${visibleText}${hint ? ` ${hint}` : ""}`);
  const pad = Math.max(0, width - rawWidth);
  const borderColor = danger ? "red" : "gray";
  return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
    palette ? React.createElement(Text, { color: "gray" }, palette) : null,
    contextSummary ? React.createElement(Text, { color: "cyan" }, `已加入本轮上下文: ${contextSummary}`) : null,
    React.createElement(Box, { borderStyle: "single", borderColor, paddingX: 1 },
      React.createElement(Text, { color: "white" }, prompt),
      React.createElement(Text, { color: value ? "white" : "gray" }, visibleText),
      !multiline && hint ? React.createElement(Text, { color: "gray" }, ` ${hint}`) : null,
      !multiline && pad ? React.createElement(Text, null, " ".repeat(pad)) : null,
    ),
  );
}

export function slashHint(input: string, commands: string[], maxWidth = 72): string {
  if (!input.startsWith("/") || !commands.length) return "";
  const completion = completeSlash(input, commands);
  if (!completion.matches.length) return "";
  const suffix = completion.completed.length > input.length ? completion.completed.slice(input.length) : "";
  const candidates = completion.matches.slice(0, suffix ? 4 : 5).join("  ");
  const hint = suffix ? `${suffix}    ${candidates}` : candidates;
  return truncateMiddle(hint, Math.max(8, maxWidth - visibleLength(input) - 4));
}

export function slashPalette(input: string, commands: string[], maxItems = 6): string {
  const normalized = normalizeSlashInput(input);
  if (!normalized.startsWith("/") || !commands.length) return "";
  const completion = completeSlash(normalized, commands);
  if (!completion.matches.length) return t("slash.unknown");
  return completion.matches
    .slice(0, maxItems)
    .map((command) => `${command} ${slashCommandLabel(command)}`.trim())
    .join("   ");
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
    case "/fast":
      return t("slash.label.fast");
    case "/think":
    case "/reasoning":
      return t("slash.label.think");
    case "/help":
      return t("slash.label.help");
    case "/exit":
    case "/quit":
      return t("slash.label.exit");
    case "/tools":
      return t("slash.label.tools");
    case "/clear":
      return t("slash.label.clear");
    default:
      return "";
  }
}

function truncateMiddle(value: string, maxWidth: number): string {
  if (visibleLength(value) <= maxWidth) return value;
  if (maxWidth <= 3) return "...".slice(0, maxWidth);
  const headWidth = Math.max(1, Math.floor((maxWidth - 3) / 2));
  const tailWidth = Math.max(1, maxWidth - 3 - headWidth);
  return `${takeVisible(value, headWidth)}...${takeVisibleFromEnd(value, tailWidth)}`;
}

function takeVisible(value: string, maxWidth: number): string {
  let out = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const next = visibleLength(char);
    if (used + next > maxWidth) break;
    out += char;
    used += next;
  }
  return out;
}

function takeVisibleFromEnd(value: string, maxWidth: number): string {
  let out = "";
  let used = 0;
  for (const char of Array.from(value).reverse()) {
    const next = visibleLength(char);
    if (used + next > maxWidth) break;
    out = `${char}${out}`;
    used += next;
  }
  return out;
}
