import { describe, expect, it } from "vitest";
import { detectImageProtocol, iterm2ImageEscape, kittyImageEscape } from "../src/terminal-image.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("detectImageProtocol", () => {
  it("detects iTerm2 / kitty and respects the opt-out", () => {
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm2");
    expect(detectImageProtocol({ LC_TERMINAL: "iTerm2" })).toBe("iterm2");
    expect(detectImageProtocol({ TERM: "xterm-kitty" })).toBe("kitty");
    expect(detectImageProtocol({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(detectImageProtocol({})).toBe(null);
    expect(detectImageProtocol({ TERM_PROGRAM: "iTerm.app", LYNN_CLI_NO_INLINE_IMAGES: "1" })).toBe(null);
  });
});

describe("inline image escapes", () => {
  it("wraps base64 in the iTerm2 OSC 1337 sequence", () => {
    const esc = iterm2ImageEscape("QUJD", { widthCells: 24, name: "a.png" });
    expect(esc.startsWith(`${ESC}]1337;File=`)).toBe(true);
    expect(esc.endsWith(BEL)).toBe(true);
    expect(esc).toContain("inline=1");
    expect(esc).toContain("width=24");
    expect(esc).toContain(":QUJD");
  });

  it("frames base64 for the kitty graphics protocol", () => {
    const esc = kittyImageEscape("QUJD", { widthCells: 24 });
    expect(esc.startsWith(`${ESC}_G`)).toBe(true);
    expect(esc).toContain("a=T,f=100");
    expect(esc).toContain("c=24");
    expect(esc.endsWith(`${ESC}\\`)).toBe(true);
  });
});
