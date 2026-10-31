import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { isOwnedServerCommand } = require("../desktop/process-identity.cjs");
describe("server process ownership", () => {
  const launch = { serverBin: "/app/server/node", serverArgs: ["/app/server/index.js"] };
  it("requires both the actual executable and an exact entry path", () => {
    expect(isOwnedServerCommand("/app/server/node /app/server/index.js", launch)).toBe(true);
    expect(isOwnedServerCommand('"/app/server/node" "/app/server/index.js"', launch)).toBe(true);
    for (const command of ["/usr/bin/python job.py", "/other/node /app/server/index.js", "/app/server/node /app/server/index.js.other", "/app/server/node /other/index.js", ""]) expect(isOwnedServerCommand(command, launch)).toBe(false);
  });
  it("handles quoted Windows paths without trusting an unrelated executable", () => {
    const win = { serverBin: "C:\\Lynn App\\server\\lynn-server.exe", serverArgs: ["C:\\Lynn App\\server\\index.js"] };
    expect(isOwnedServerCommand('"C:\\Lynn App\\server\\lynn-server.exe" "C:\\Lynn App\\server\\index.js"', win)).toBe(true);
    expect(isOwnedServerCommand('"C:\\Other\\app.exe" "C:\\Lynn App\\server\\index.js"', win)).toBe(false);
  });
});
