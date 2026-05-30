import { parseArgs, hasFlag, getStringFlag, type ParsedArgs } from "./args.js";
import { checkBrainReachable } from "./brain-client.js";
import { runAgents } from "./commands/agents.js";
import { runBrain } from "./commands/brain.js";
import { runChat } from "./commands/chat.js";
import { runCode } from "./commands/code.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";
import { runMemory } from "./commands/memory.js";
import { runPermissions } from "./commands/permissions.js";
import { runPrompt } from "./commands/prompt.js";
import { activeRouteLabel, renderBrainModelChoices, resolveProvidersInfo, runProviders } from "./commands/providers.js";
import { runSessions } from "./commands/sessions.js";
import { runVisionCommand } from "./commands/vision.js";
import { runWorker } from "./commands/worker-run.js";
import { usage } from "./help.js";
import { writeJsonLine } from "./jsonl.js";
import { renderStartupBanner } from "./startup.js";
import { installPipeErrorHandler } from "./stdio.js";
import { classifyTaskRoute, codeArgsForRoute, visionArgsForRoute } from "./task-classifier.js";
import { readVersionInfo } from "./version.js";
import { maybePromptForCliUpdate } from "./self-update.js";
import type { ProvidersInfo } from "./commands/providers.js";
import { t } from "./i18n.js";
import { resolveDefaultBrainUrl } from "./brain-url.js";

async function main(argv = process.argv.slice(2)): Promise<number> {
  installPipeErrorHandler();

  if (argv.length === 0) {
    const providerInfo = await resolveProvidersInfo({ command: "providers", positionals: [], flags: {} }, 500);
    const brainUrl = await resolveDefaultBrainUrl({ command: "chat", positionals: [], flags: {} }, 500);
    const brainReachable = await checkBrainReachable(brainUrl, 500);
    const startupInfo: ProvidersInfo = { ...providerInfo, brainUrl };
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await maybePromptForCliUpdate({ command: "chat", positionals: [], flags: { ink: true } }, readVersionInfo());
      if (process.env.LYNN_CLI_LEGACY_TUI !== "1") {
        return runChat({ command: "chat", positionals: [], flags: { ink: true, "brain-url": brainUrl } }, { intro: false, brainReachable });
      }
      process.stdout.write(`${renderStartupBanner({
        brainUrl,
        brainStatus: brainReachable ? "online" : "offline",
        modelLabel: startupModelLabel(startupInfo, brainReachable),
        byokLabel: startupInfo.cliProvider?.configured ? t("startup.byok.cliFallback") : undefined,
        showTips: brainReachable,
      })}\n`);
      // Always enter the interactive REPL — even when the Brain is offline.
      // runChat prints the offline hint, then each message returns an actionable
      // recovery line (configure BYOK / start the client) instead of dropping the
      // user back to the shell (which made `Lynn` look like it "doesn't work").
      return runChat({ command: "chat", positionals: [], flags: { "brain-url": brainUrl } }, { intro: false, brainReachable });
    }
    process.stdout.write(`${renderStartupBanner({
      brainUrl,
      brainStatus: brainReachable ? "online" : "offline",
      modelLabel: startupModelLabel(startupInfo, brainReachable),
      byokLabel: startupInfo.cliProvider?.configured ? t("startup.byok.cliFallback") : undefined,
      showTips: brainReachable,
    })}\n`);
    return 0;
  }
  const args = parseArgs(argv);
  const json = hasFlag(args.flags, "json", "jsonl");
  await maybePromptForCliUpdate(args, readVersionInfo());

  if (shouldResumeCodeInvocation(args)) {
    return runCode(resumeCodeArgs(args));
  }

  if (isImplicitChatInvocation(args)) {
    return runChat({ ...args, command: "chat" });
  }

  switch (args.command) {
    case "version": {
      const info = readVersionInfo();
      if (json) writeJsonLine({ type: "version", ...info });
      else process.stdout.write(`${info.name} ${info.version}\n`);
      return 0;
    }
    case "doctor": {
      const result = await runDoctor(args);
      if (json) writeJsonLine({ type: "doctor", ...result });
      else process.stdout.write(`${renderDoctor(result)}\n`);
      return result.ok ? 0 : 2;
    }
    case "chat": {
      return runChat(args);
    }
    case "brain": {
      return runBrain(args);
    }
    case "agents": {
      return runAgents(args, json);
    }
    case "providers": {
      return runProviders(args, json);
    }
    case "setup": {
      return runProviders(providerSetupArgs(args), json);
    }
    case "byok": {
      return runProviders(providerSetupArgs(args), json);
    }
    case "permissions": {
      return runPermissions(args, json);
    }
    case "model": {
      if (!args.positionals.length && !json) {
        process.stdout.write(`${renderBrainModelChoices(await resolveProvidersInfo(args))}\n`);
        return 0;
      }
      return runProviders(providerModelArgs(args), json);
    }
    case "memory": {
      return runMemory(args, json);
    }
    case "prompt":
    case "exec": {
      return runPrompt(args, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
    }
    case "goal": {
      return runCode(codeArgsForRoute(args, { kind: "goal", reason: "explicit goal command" }));
    }
    case "worker": {
      return runWorker(args);
    }
    case "code": {
      return runCode(args);
    }
    case "see":
    case "ground":
    case "ui2code": {
      return runVisionCommand(args, args.command, json);
    }
    case "sessions": {
      return runSessions(args, json);
    }
    case "help":
    case "--help":
    case "-h": {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    default: {
      if (args.command === "-p" || args.command === "--print") {
        return runPrompt(args, { json, mockBrain: hasFlag(args.flags, "mock-brain", "mock") });
      }
      const route = classifyTaskRoute(args);
      if (route.kind === "goal" || route.kind === "code") {
        return runCode(codeArgsForRoute(args, route));
      }
      if (route.kind === "vision") {
        return runVisionCommand(visionArgsForRoute(args), "see", json);
      }
      return runPrompt({ ...args, command: "prompt", positionals: [args.command, ...args.positionals] }, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
    }
  }
}

function isImplicitChatInvocation(args: ReturnType<typeof parseArgs>): boolean {
  if (args.command !== "help") return false;
  if (hasFlag(args.flags, "help", "h", "version", "v")) return false;
  return hasFlag(
    args.flags,
    "mock-brain",
    "mock",
    "brain-url",
    "reasoning",
    "show-reasoning",
    "approval",
    "sandbox",
    "cwd",
    "base-url",
    "api-base",
    "api-key",
    "model",
    "preset",
    "data-dir",
  );
}

function shouldResumeCodeInvocation(args: ParsedArgs): boolean {
  if (args.command === "code") return false;
  if (hasFlag(args.flags, "continue") && (args.command === "help" || args.command === "continue")) return true;
  if (!hasFlag(args.flags, "resume")) return false;
  return args.command === "help" || !isKnownTopLevelCommand(args.command);
}

function resumeCodeArgs(args: ParsedArgs): ParsedArgs {
  const flags = { ...args.flags };
  if (hasFlag(flags, "continue") && !getStringFlag(flags, "resume")) flags.resume = "last";
  const continuation = resumeContinuation(args);
  return {
    ...args,
    command: "code",
    flags: {
      ...flags,
      long: flags.long ?? true,
    },
    positionals: continuation,
  };
}

function resumeContinuation(args: ParsedArgs): string[] {
  if (args.command !== "help" && args.command !== "continue") return [args.command, ...args.positionals];
  if (args.positionals.length > 0) return args.positionals;
  return ["继续这个任务"];
}

function isKnownTopLevelCommand(command: string): boolean {
  return TOP_LEVEL_COMMANDS.has(command);
}

const TOP_LEVEL_COMMANDS = new Set([
  "version",
  "doctor",
  "chat",
  "brain",
  "agents",
  "providers",
  "setup",
  "byok",
  "permissions",
  "model",
  "memory",
  "goal",
  "prompt",
  "exec",
  "worker",
  "code",
  "see",
  "ground",
  "ui2code",
  "sessions",
  "help",
  "--help",
  "-h",
]);

function startupModelLabel(info: ProvidersInfo, brainReachable: boolean): string {
  if (!brainReachable && info.cliProvider?.configured && info.cliProvider.profile) {
    return `CLI BYOK: ${info.cliProvider.profile.model}`;
  }
  const label = activeRouteLabel(info);
  if (/^brain\s*\/\s*lynn-brain-router/i.test(label)) return "StepFun 3.7 Flash → MiMo V2.5 Pro";
  if (/^MiMo via .*Brain router/i.test(label)) return "MiMo V2.5 Pro";
  if (/^StepFun.*MiMo/i.test(label)) return "StepFun 3.7 Flash → MiMo V2.5 Pro";
  return label;
}

function providerModelArgs(args: ParsedArgs): ParsedArgs {
  const head = (args.positionals[0] || "").toLowerCase();
  if (!head || head === "set" || head === "unset" || head === "clear" || head === "reset" || head === "test" || head === "presets") {
    return { ...args, command: "providers" };
  }
  const flags = { ...args.flags };
  if (getStringFlag(flags, "base-url", "api-base")) {
    if (!getStringFlag(flags, "model")) flags.model = args.positionals[0];
  } else if (!getStringFlag(flags, "preset")) {
    flags.preset = args.positionals[0];
  }
  return {
    ...args,
    command: "providers",
    positionals: ["set", ...args.positionals.slice(1)],
    flags,
  };
}

function providerSetupArgs(args: ParsedArgs): ParsedArgs {
  const head = (args.positionals[0] || "").toLowerCase();
  if (!head) return { ...args, command: "providers", positionals: ["set"] };
  if (head === "set" || head === "unset" || head === "clear" || head === "reset" || head === "test" || head === "presets") {
    return { ...args, command: "providers" };
  }
  const flags = { ...args.flags };
  if (getStringFlag(flags, "base-url", "api-base")) {
    if (!getStringFlag(flags, "model")) flags.model = args.positionals[0];
  } else if (!getStringFlag(flags, "preset")) {
    flags.preset = args.positionals[0];
  }
  return {
    ...args,
    command: "providers",
    positionals: ["set", ...args.positionals.slice(1)],
    flags,
  };
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lynn: ${message}\n`);
  process.exitCode = 1;
});
