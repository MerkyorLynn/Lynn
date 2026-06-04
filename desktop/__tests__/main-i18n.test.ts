import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLocaleKey, interpolate, createMainI18n } = require("../main-i18n.cjs");

describe("resolveLocaleKey", () => {
  it("maps locales to the right pack key", () => {
    expect(resolveLocaleKey("zh-TW")).toBe("zh-TW");
    expect(resolveLocaleKey("zh-Hant")).toBe("zh-TW");
    expect(resolveLocaleKey("zh-CN")).toBe("zh");
    expect(resolveLocaleKey("ja-JP")).toBe("ja");
    expect(resolveLocaleKey("ko")).toBe("ko");
    expect(resolveLocaleKey("en-US")).toBe("en");
    expect(resolveLocaleKey("fr")).toBe("en");
    expect(resolveLocaleKey(null)).toBe("zh");
    expect(resolveLocaleKey("")).toBe("zh");
  });
});

describe("interpolate", () => {
  it("replaces {key} placeholders, leaves text without vars unchanged", () => {
    expect(interpolate("hi {name}", { name: "Lynn" })).toBe("hi Lynn");
    expect(interpolate("{a}+{a}={b}", { a: "1", b: "2" })).toBe("1+1=2");
    expect(interpolate("plain", undefined)).toBe("plain");
  });
});

describe("createMainI18n (injected lynnHome + localesDir)", () => {
  function setup(locale: string | null, pack: Record<string, unknown>): { lynnHome: string; localesDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-i18n-"));
    const lynnHome = path.join(root, "home");
    const localesDir = path.join(root, "locales");
    fs.mkdirSync(lynnHome, { recursive: true });
    fs.mkdirSync(localesDir, { recursive: true });
    if (locale !== null) fs.writeFileSync(path.join(lynnHome, "preferences.json"), JSON.stringify({ locale }));
    const key = resolveLocaleKey(locale);
    fs.writeFileSync(path.join(localesDir, `${key}.json`), JSON.stringify({ main: pack }));
    return { lynnHome, localesDir };
  }

  it("translates by dot-path from the resolved locale pack", () => {
    const { mt } = createMainI18n(setup("en-US", { tray: { show: "Show" } }));
    expect(mt("tray.show")).toBe("Show");
  });
  it("falls back to fallback or dotPath when missing", () => {
    const { mt } = createMainI18n(setup("en", { tray: {} }));
    expect(mt("tray.missing", undefined, "Fallback")).toBe("Fallback");
    expect(mt("nope.nope")).toBe("nope.nope");
  });
  it("interpolates vars in translations", () => {
    const { mt } = createMainI18n(setup("en", { msg: { hi: "Hi {who}" } }));
    expect(mt("msg.hi", { who: "Lynn" })).toBe("Hi Lynn");
  });
  it("returns {} pack (dotPath fallback) when files are missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-i18n-empty-"));
    const { mt } = createMainI18n({ lynnHome: root, localesDir: root });
    expect(mt("any.path", undefined, "fb")).toBe("fb");
  });
});
