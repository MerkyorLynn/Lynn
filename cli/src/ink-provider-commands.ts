import { type ParsedArgs } from "./args.js";
import { buildChatProviderArgs, shouldRefreshProviderRoute, shouldShowProviderSetUsage } from "./commands/chat.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./commands/providers.js";
import { normalizeSlashInput } from "./completion.js";
import { t } from "./i18n.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "./provider-profile.js";

export interface InkProviderCommandResult {
  handled: boolean;
  message: string;
  refreshedProvider?: CliProviderProfile | null;
}

export async function handleInkProviderCommand(raw: string, baseArgs: ParsedArgs): Promise<InkProviderCommandResult> {
  const text = normalizeSlashInput(raw.trim());
  if (text === "/model") {
    return {
      handled: true,
      message: renderBrainModelChoices(await resolveProvidersInfo(baseArgs)),
    };
  }
  if (text === "/providers" || text === "/byok") {
    return {
      handled: true,
      message: renderProvidersInfo(await resolveProvidersInfo(baseArgs)),
    };
  }

  const providerCommand = buildChatProviderArgs(text, baseArgs);
  if (!providerCommand) return { handled: false, message: "" };
  if (shouldShowProviderSetUsage(providerCommand, false)) {
    return { handled: true, message: t("chat.providers.setUsage") };
  }

  const message = await captureStdout(() => runProviders(providerCommand, false));
  const refreshedProvider = shouldRefreshProviderRoute(providerCommand)
    ? (await resolveCliProviderProfile(providerCommand) || await resolveCliProviderProfile(baseArgs))?.profile || null
    : undefined;
  return {
    handled: true,
    message: message.trim() || t("chat.providers.routeUnchanged", { route: refreshedProvider?.model || "StepFun 3.7 Flash" }),
    refreshedProvider,
  };
}

async function captureStdout(fn: () => Promise<number>): Promise<string> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = original;
  }
}
