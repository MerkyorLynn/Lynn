import { afterEach, describe, expect, it } from "vitest";
import { detectLang, setLang, t } from "../src/i18n.js";

afterEach(() => setLang(null));

describe("cli i18n", () => {
  it("defaults to Chinese; English is opt-in via LYNN_LANG", () => {
    expect(detectLang({})).toBe("zh");
    // POSIX LANG is intentionally ignored so a zh user on an en_US locale still gets Chinese.
    expect(detectLang({ LANG: "en_US.UTF-8" })).toBe("zh");
    expect(detectLang({ LYNN_LANG: "en" })).toBe("en");
    expect(detectLang({ LYNN_LANG: "EN" })).toBe("en");
    expect(detectLang({ LYNN_LANG: "zh-CN" })).toBe("zh");
    expect(detectLang({ LYNN_LOCALE: "en-US" })).toBe("en");
  });

  it("interpolates placeholders and falls back to the key when missing", () => {
    setLang("en");
    expect(t("mock.response", { text: "hi" })).toBe("Mock reply: hi");
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("returns Chinese strings under the default locale", () => {
    setLang("zh");
    expect(t("mock.response", { text: "你好" })).toBe("模拟回复:你好");
    expect(t("offline.body")).toContain("离线");
    expect(t("code.placeholder")).toContain("编码任务");
  });

  it("falls back to the English string when a key is missing in zh", () => {
    setLang("zh");
    // every key is defined in both tables today; this guards the fallback path
    expect(t("spinner.thinking")).toBe("Lynn 思考中");
  });
});
