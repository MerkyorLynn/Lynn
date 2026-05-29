import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { buildImageContentParts } from "../media.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";

export type VisionCommand = "see" | "ground" | "ui2code";

export async function runVisionCommand(args: ParsedArgs, command: VisionCommand, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  const imagePath = getStringFlag(args.flags, "image", "shot") || args.positionals[0] || "";
  if (!imagePath) throw new Error(`${command} requires an image path`);
  const userText = args.positionals.slice(1).join(" ").trim() || getStringFlag(args.flags, "prompt", "p") || "";
  const prompt = buildVisionPrompt(command, userText);
  const reasoning = parseReasoningOptions(args);
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const cliProvider = await resolveCliProviderProfile(args);

  if (json) writeJsonLine({ type: "vision.started", ts: nowIso(), command, image: imagePath, prompt, reasoning });

  if (mockBrain) {
    const text = `${t("mock.vision", { command, path: imagePath })}${userText ? ` · ${userText}` : ""}`;
    if (json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "vision.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return 0;
  }

  const content = await buildImageContentParts(imagePath, prompt);
  let answer = "";
  const renderState: HumanBrainRenderState = {};
  const spinner = new TerminalSpinner(process.stderr, command === "ground" ? "Lynn is grounding" : "Lynn is seeing");
  if (!json) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl,
      reasoning,
      messages: [{ role: "user", content }],
      fallbackProvider: cliProvider?.profile,
    })) {
      const renderReasoning = shouldRenderReasoning(reasoning.display, json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) spinner.stop();
      renderVisionEvent(event, { json, renderReasoning, renderState });
      if (event.type === "assistant.delta") answer += event.text;
      if (event.type === "brain.error") throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
    }
  } finally {
    spinner.stop();
  }
  if (json) writeJsonLine({ type: "vision.finished", ts: nowIso(), ok: true, contentReturned: !!answer.trim() });
  else process.stdout.write("\n");
  return 0;
}

export function buildVisionPrompt(command: VisionCommand, userText: string): string {
  if (command === "ground") {
    return [
      "You are Lynn CLI visual grounding mode.",
      `Target: ${userText || "the primary actionable UI element"}`,
      "Return concise JSON first: {\"x\":0.0,\"y\":0.0,\"confidence\":0.0,\"reason\":\"...\"}.",
      "x and y must be normalized to [0,1] relative to the image.",
      "After JSON, add one short sentence only if useful.",
    ].join("\n");
  }
  if (command === "ui2code") {
    return [
      "You are Lynn CLI UI-to-code mode.",
      "Analyze the screenshot/mockup and produce an implementation plan plus code-oriented structure.",
      "Prefer component boundaries, layout, states, and accessibility notes.",
      userText ? `User request: ${userText}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "You are Lynn CLI vision mode.",
    "Describe the image. If it is a UI screenshot, identify screens, controls, visible text, layout, and possible issues.",
    userText ? `User request: ${userText}` : "",
  ].filter(Boolean).join("\n");
}

function renderVisionEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean; renderState: HumanBrainRenderState }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") writeJsonLine({ ...event, ts: nowIso() });
    else if (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error") writeJsonLine({ ...event, ts: nowIso() });
    else if (event.type === "usage") writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
    return;
  }
  if (event.type === "assistant.delta") process.stdout.write(event.text);
  else if (event.type === "reasoning.delta" && opts.renderReasoning) process.stderr.write(event.text);
  else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage);
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, opts.renderState, process.stderr);
  }
}
