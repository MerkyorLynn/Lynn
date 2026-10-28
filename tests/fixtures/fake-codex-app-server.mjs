import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const scenario = process.argv[2] || "default";
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    send({ id: message.id, error: { code: -32000, message: "not initialized" } });
    return;
  }
  if (message.method === "thread/start") {
    if (scenario === "slow-thread-start") {
      setTimeout(() => send({ id: message.id, result: { thread: { id: "thread-1", turns: [] } } }), 5_200);
      return;
    }
    send({ id: message.id, result: { thread: { id: "thread-1", turns: [] }, model: "fake", modelProvider: "fake", cwd: "/tmp" } });
    return;
  }
  if (message.method === "turn/start") {
    if (scenario === "coalesced-completed" || scenario === "coalesced-error") {
      const terminal = scenario === "coalesced-completed"
        ? { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } }
        : { method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "coalesced failure" } } };
      process.stdout.write([
        { id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } },
        terminal,
      ].map((item) => JSON.stringify(item)).join("\n") + "\n");
      return;
    }
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    if (scenario === "crash") {
      setTimeout(() => process.exit(17), 10);
      return;
    }
    queueMicrotask(() => {
      if (scenario === "resume") {
        const text = message.params?.input?.find?.((item) => item.type === "text")?.text || "";
        if (!text.includes("[Lynn durable memory]") || !text.includes("remember alpha") || !text.includes("[Lynn resumed conversation") || !text.includes("earlier answer") || !text.includes("[Current task]\ncontinue now")) {
          send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "resume context missing" } } });
          return;
        }
        send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-resume", delta: "resumed" } });
        send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
        return;
      }
      if (scenario === "approvals") {
        send({ id: "approval-v2", method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", command: "pwd", cwd: "/tmp" } });
        return;
      }
      if (scenario === "elicitation") {
        send({ id: "user-input-1", method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", itemId: "input-1", questions: [] } });
        return;
      }
      send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" } });
      send({ id: "server-tool-1", method: "item/tool/call", params: { threadId: "thread-1", turnId: "turn-1", callId: "call-1", tool: "read_file", arguments: { path: "README.md" } } });
    });
    return;
  }
  if (message.id === "user-input-1") {
    if (!message.result || typeof message.result.answers !== "object") {
      send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "invalid user input response" } } });
      return;
    }
    send({ id: "elicitation-1", method: "mcpServer/elicitation/request", params: { threadId: "thread-1", turnId: "turn-1", serverName: "fake", message: "input", mode: "form", requestedSchema: {} } });
    return;
  }
  if (message.id === "elicitation-1") {
    if (message.result?.action !== "decline") {
      send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "invalid elicitation response" } } });
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-elicitation", delta: "declined safely" } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    return;
  }
  if (message.id === "approval-v2") {
    if (message.result?.decision !== "acceptForSession") {
      send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "invalid v2 approval response" } } });
      return;
    }
    send({ id: "approval-permissions", method: "item/permissions/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "perm-1", reason: "network", permissions: { network: { enabled: true }, fileSystem: null } } });
    return;
  }
  if (message.id === "approval-permissions") {
    if (message.result?.scope !== "session" || message.result?.permissions?.network?.enabled !== true) {
      send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "invalid permissions approval response" } } });
      return;
    }
    send({ id: "approval-legacy", method: "execCommandApproval", params: { conversationId: "thread-1", callId: "legacy-1", command: ["pwd"], cwd: "/tmp", reason: null, parsedCmd: [] } });
    return;
  }
  if (message.id === "approval-legacy") {
    if (message.result?.decision !== "approved_for_session") {
      send({ method: "error", params: { threadId: "thread-1", turnId: "turn-1", willRetry: false, error: { message: "invalid legacy approval response" } } });
      return;
    }
    send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-approval", delta: "approved" } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    return;
  }
  if (message.id === "server-tool-1" && message.result) {
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "never/reply") return;
  send({ id: message.id, result: {} });
});
