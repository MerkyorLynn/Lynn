import { parseArgs, hasFlag } from "./args.js";
import { checkBrainReachable } from "./brain-client.js";
import { runAgents } from "./commands/agents.js";
import { renderOfflineChatHint, runChat } from "./commands/chat.js";
import { runCode } from "./commands/code.js";
import { renderDoctor, runDoctor } from "./commands/doctor.js";
import { runPermissions } from "./commands/permissions.js";
import { runPrompt } from "./commands/prompt.js";
import { activeRouteLabel, resolveProvidersInfo, runProviders } from "./commands/providers.js";
import { runSessions } from "./commands/sessions.js";
import { runVisionCommand } from "./commands/vision.js";
import { runWorker } from "./commands/worker-run.js";
import { usage } from "./help.js";
import { writeJsonLine } from "./jsonl.js";
import { renderStartupBanner } from "./startup.js";
import { readVersionInfo } from "./version.js";

async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) {
    const providerInfo = await resolveProvidersInfo({ command: "providers", positionals: [], flags: {} }, 500);
    const brainReachable = await checkBrainReachable(providerInfo.brainUrl, 300);
    process.stdout.write(`${renderStartupBanner({
      brainUrl: providerInfo.brainUrl,
      brainStatus: brainReachable ? "online" : "offline",
      modelLabel: activeRouteLabel(providerInfo),
      showTips: brainReachable,
    })}\n`);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      if (!brainReachable) {
        process.stdout.write(`${renderOfflineChatHint({ approval: "ask", sandbox: "workspace-write" }, providerInfo.brainUrl)}\n`);
        return 2;
      }
      return runChat({ command: "chat", positionals: [], flags: {} }, { intro: false, brainReachable });
    }
    return 0;
  }
  const args = parseArgs(argv);
  const json = hasFlag(args.flags, "json", "jsonl");

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
    case "agents": {
      return runAgents(args, json);
    }
    case "providers": {
      return runProviders(args, json);
    }
    case "permissions": {
      return runPermissions(args, json);
    }
    case "model": {
      return runProviders(args, json);
    }
    case "prompt":
    case "exec": {
      return runPrompt(args, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
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
      return runPrompt({ ...args, command: "prompt", positionals: [args.command, ...args.positionals] }, {
        json,
        mockBrain: hasFlag(args.flags, "mock-brain", "mock"),
      });
    }
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`lynn: ${message}\n`);
  process.exitCode = 1;
});
