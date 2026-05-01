import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { getGlobalSummonShortcuts, registerFirstAvailableGlobalShortcut } = require("../desktop/shortcut-policy.cjs");

describe("Jarvis global shortcut policy", () => {
  it("uses Cmd+Shift+L on macOS with Cmd+Option+J fallback", () => {
    expect(getGlobalSummonShortcuts("darwin")).toEqual(["Command+Shift+L", "Command+Option+J"]);
  });

  it("uses Ctrl+Shift+L on Windows/Linux with Ctrl+Alt+J fallback", () => {
    expect(getGlobalSummonShortcuts("win32")).toEqual(["Control+Shift+L", "Control+Alt+J"]);
    expect(getGlobalSummonShortcuts("linux")).toEqual(["Control+Shift+L", "Control+Alt+J"]);
  });

  it("registers fallback when the default accelerator is occupied", () => {
    const register = vi.fn((accelerator) => accelerator === "Command+Option+J");
    const result = registerFirstAvailableGlobalShortcut({ register }, vi.fn(), "darwin");
    expect(register).toHaveBeenCalledWith("Command+Shift+L", expect.any(Function));
    expect(register).toHaveBeenCalledWith("Command+Option+J", expect.any(Function));
    expect(result).toMatchObject({
      ok: true,
      accelerator: "Command+Option+J",
      fallbackUsed: true,
    });
  });

  it("tries a configured accelerator before platform defaults", () => {
    const register = vi.fn((accelerator) => accelerator === "Command+Control+L");
    const result = registerFirstAvailableGlobalShortcut({ register }, vi.fn(), "darwin", " Command + Control + L ");
    expect(register).toHaveBeenNthCalledWith(1, "Command+Control+L", expect.any(Function));
    expect(result).toMatchObject({
      ok: true,
      accelerator: "Command+Control+L",
      configured: "Command+Control+L",
      layer: "configured",
    });
  });

  it("reports a clean failure when both accelerators are occupied", () => {
    const result = registerFirstAvailableGlobalShortcut({ register: vi.fn(() => false) }, vi.fn(), "win32");
    expect(result).toMatchObject({
      ok: false,
      accelerator: null,
      attempted: ["Control+Shift+L", "Control+Alt+J"],
    });
  });
});
