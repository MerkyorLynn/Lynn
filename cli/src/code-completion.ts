import { streamBrainChat } from "./brain-client.js";
import { parseReasoningOptions } from "./reasoning.js";
import type { CliProviderProfile } from "./provider-profile.js";

/** Collect a single non-tool model completion, used for skill distillation. */
export async function collectOneCompletion(
  brainUrl: string,
  fallbackProvider: CliProviderProfile | undefined,
  reasoning: ReturnType<typeof parseReasoningOptions>,
  prompt: string,
): Promise<string> {
  let text = "";
  for await (const event of streamBrainChat({ brainUrl, prompt, reasoning, fallbackProvider })) {
    if (event.type === "assistant.delta") text += event.text;
    else if (event.type === "brain.error") throw new Error(event.error);
  }
  return text;
}
