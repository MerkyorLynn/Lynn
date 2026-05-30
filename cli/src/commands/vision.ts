import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { buildImagesContentParts, parseImageList } from "../media.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { extractGroundingBoxes, renderGroundingSummary } from "../vision-result.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";

export type VisionCommand = "see" | "ground" | "ui2code";

export async function runVisionCommand(args: ParsedArgs, command: VisionCommand, json = hasFlag(args.flags, "json", "jsonl")): Promise<number> {
  const { imagePaths, userText } = resolveVisionInput(args);
  const imagePath = imagePaths[0] || "";
  if (!imagePaths.length) throw new Error(t("vision.error.imageRequired", { command }));
  const prompt = buildVisionPrompt(command, userText);
  const reasoning = parseReasoningOptions(args);
  const brainUrl = await resolveDefaultBrainUrl(args);
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const cliProvider = await resolveCliProviderProfile(args);

  if (json) writeJsonLine({ type: "vision.started", ts: nowIso(), command, image: imagePath, images: imagePaths, prompt, reasoning });

  if (mockBrain) {
    const text = `${t("mock.vision", { command, path: imagePaths.join(", ") })}${userText ? ` · ${userText}` : ""}`;
    if (json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "vision.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    return 0;
  }

  const content = await buildImagesContentParts(imagePaths, prompt);
  let answer = "";
  const renderState: HumanBrainRenderState = {};
  const spinner = new TerminalSpinner(process.stderr, command === "ground" ? t("spinner.grounding") : t("spinner.seeing"));
  const startedAt = Date.now();
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
      if (event.type === "brain.error") {
        if (json) renderVisionEvent(event, { json, renderReasoning, renderState, startedAt });
        throw new Error(formatBrainErrorForHuman(event.error, event.code));
      }
      renderVisionEvent(event, { json, renderReasoning, renderState, startedAt });
      if (event.type === "assistant.delta") answer += event.text;
    }
  } finally {
    spinner.stop();
  }
  const groundingBoxes = command === "ground" ? extractGroundingBoxes(answer) : [];
  if (json) {
    if (command === "ground") {
      writeJsonLine({ type: "vision.result", ts: nowIso(), command, image: imagePath, images: imagePaths, boxes: groundingBoxes });
    }
    writeJsonLine({ type: "vision.finished", ts: nowIso(), ok: true, images: imagePaths, contentReturned: !!answer.trim() });
  }
  else {
    const summary = renderGroundingSummary(groundingBoxes);
    if (summary) process.stdout.write(`\n${summary}`);
    process.stdout.write("\n");
  }
  return 0;
}

function resolveVisionInput(args: ParsedArgs): { imagePaths: string[]; userText: string } {
  const fromFlags = [
    ...parseImageList(getStringFlag(args.flags, "images")),
    ...parseImageList(getStringFlag(args.flags, "image", "shot")),
  ];
  if (fromFlags.length) {
    return {
      imagePaths: fromFlags,
      userText: args.positionals.join(" ").trim() || getStringFlag(args.flags, "prompt", "p") || "",
    };
  }
  const [first, ...rest] = args.positionals;
  return {
    imagePaths: first ? [first] : [],
    userText: rest.join(" ").trim() || getStringFlag(args.flags, "prompt", "p") || "",
  };
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

function renderVisionEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean; renderState: HumanBrainRenderState; startedAt?: number }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") writeJsonLine({ ...event, ts: nowIso() });
    else if (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error") writeJsonLine({ ...event, ts: nowIso() });
    else if (event.type === "usage") writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage, durationMs: opts.startedAt ? Date.now() - opts.startedAt : undefined });
    return;
  }
  if (event.type === "assistant.delta") process.stdout.write(event.text);
  else if (event.type === "reasoning.delta" && opts.renderReasoning) process.stderr.write(event.text);
  else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage, { durationMs: opts.startedAt ? Date.now() - opts.startedAt : undefined });
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, opts.renderState, process.stderr);
  }
}
