import { describe, expect, it } from "vitest";
import {
  getConfiguredTrustedRoots,
  getDefaultDesktopRoot,
  getEffectiveTrustedRoots,
  getWorkspaceRoots,
  normalizeTrustedRoot,
  uniqueTrustedRoots,
} from "../shared/trusted-roots.js";

describe("trusted-roots helpers", () => {
  it("returns no implicit trusted roots when workspace is not configured", () => {
    const roots = getEffectiveTrustedRoots({});
    expect(roots).toEqual([]);
  });

  it("normalizes and deduplicates roots", () => {
    const roots = uniqueTrustedRoots(["~/Desktop", "~/Desktop", " /tmp/demo "]);
    expect(roots.length).toBe(2);
    expect(roots[0]).toContain("Desktop");
    expect(roots[1]).toBe(normalizeTrustedRoot("/tmp/demo"));
  });

  it("loads trusted roots from both top-level and desk namespace", () => {
    const prefs = {
      trusted_roots: ["/tmp/a"],
      desk: { trusted_roots: ["/tmp/b"] },
    };

    const roots = getConfiguredTrustedRoots(prefs);
    expect(roots).toEqual(expect.arrayContaining([
      normalizeTrustedRoot("/tmp/a"),
      normalizeTrustedRoot("/tmp/b"),
    ]));
  });

  it("workspace roots include trusted roots and cwd history", () => {
    const config = {
      last_cwd: "/tmp/current",
      cwd_history: ["/tmp/history"],
    };
    const prefs = { trusted_roots: ["/tmp/trusted"] };

    const roots = getWorkspaceRoots(config, prefs);
    expect(roots).toEqual(expect.arrayContaining([
      normalizeTrustedRoot("/tmp/current"),
      normalizeTrustedRoot("/tmp/history"),
      normalizeTrustedRoot("/tmp/trusted"),
    ]));
  });

  it("ignores the legacy Desktop seed until onboarding is completed", () => {
    const desktopRoot = getDefaultDesktopRoot();
    const prefs = {
      home_folder: desktopRoot,
      trusted_roots: [desktopRoot],
      setupComplete: false,
    };

    expect(getEffectiveTrustedRoots(prefs)).toEqual([]);
  });
});
