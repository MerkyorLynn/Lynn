import { describe, expect, it } from "vitest";
import { assertWorkspaceBashAllowed } from "../src/tools/bash.js";

const check = (command: string) => () => assertWorkspaceBashAllowed(command, "workspace-write");

describe("assertWorkspaceBashAllowed", () => {
  it("allows safe allowlisted commands", () => {
    expect(check("npm test")).not.toThrow();
    expect(check("git status")).not.toThrow();
    expect(check("rg foo src")).not.toThrow();
  });

  it("blocks non-allowlisted binaries (default-deny allowlist)", () => {
    expect(check("rm -rf foo")).toThrow();
    expect(check("eval $X")).toThrow();
  });

  it("blocks destructive uses of allowlisted binaries (find / git)", () => {
    expect(check("find . -delete")).toThrow();
    expect(check("find . -name '*.ts' -exec rm {} +")).toThrow();
    expect(check("git clean -fdx")).toThrow();
  });

  it("blocks workspace escapes, chaining, and absolute redirects", () => {
    expect(check("cat ../../etc/passwd")).toThrow();
    expect(check("ls; rm -rf /")).toThrow();
    expect(check("git log > /tmp/x")).toThrow();
  });

  it("allows everything in danger-full-access", () => {
    expect(() => assertWorkspaceBashAllowed("find . -delete", "danger-full-access")).not.toThrow();
  });
});
