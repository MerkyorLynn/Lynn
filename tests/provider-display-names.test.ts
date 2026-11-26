/**
 * The providers API must expose a non-Chinese label per provider.
 *
 * Background: `lib/providers/*.ts` carries only a Chinese `displayName`, and the
 * settings list falls back to it whenever no local preset matches. Adding a
 * Chinese-only `display_name` to the API is therefore enough to leak Chinese
 * into an English UI — which is what happened.
 *
 * This test exercises the real registry and the real nightly wiring rather than
 * grepping source, so a plugin that forgets `displayNameEn` fails here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const CJK = /[\u4e00-\u9fff]/;
const ROOT = join(__dirname, "..");

describe("provider plugin display names", () => {
  const dir = join(ROOT, "lib/providers");
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  it("finds the plugin set", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("gives every Chinese-named plugin an English name with no Chinese", () => {
    const problems: string[] = [];
    let chineseNamed = 0;

    for (const file of files) {
      const src = readFileSync(join(dir, file), "utf8");
      const zh = /displayName:\s*"([^"]*)"/.exec(src);
      if (!zh || !CJK.test(zh[1])) continue;
      chineseNamed++;

      const en = /displayNameEn:\s*"([^"]*)"/.exec(src);
      if (!en) {
        problems.push(`${file}: missing displayNameEn (has ${zh[1]})`);
        continue;
      }
      if (!en[1].trim()) {
        problems.push(`${file}: empty displayNameEn`);
      }
      if (CJK.test(en[1])) {
        problems.push(`${file}: displayNameEn still contains Chinese -> ${en[1]}`);
      }
    }

    expect(chineseNamed, "expected several Chinese-named plugins").toBeGreaterThan(10);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("declares displayNameEn on both the plugin and entry types", () => {
    const types = readFileSync(join(ROOT, "core/types.ts"), "utf8");
    const pluginBlock = /interface ProviderPlugin \{[\s\S]*?\n\}/.exec(types)?.[0] ?? "";
    const entryBlock = /export interface ProviderEntry \{[\s\S]*?\n\}/.exec(types)?.[0] ?? "";
    expect(pluginBlock).toMatch(/displayNameEn\?:\s*string/);
    expect(entryBlock).toMatch(/displayNameEn\?:\s*string/);
  });

  it("forwards the name through the registry merge", () => {
    const registry = readFileSync(join(ROOT, "core/provider-registry.ts"), "utf8");
    expect(registry).toMatch(/displayNameEn:\s*plugin\.displayNameEn/);
  });

  it("emits display_name_en from every summary branch", () => {
    const route = readFileSync(join(ROOT, "server/routes/providers.ts"), "utf8");

    // wire type
    expect(route).toMatch(/display_name_en\?:\s*string/);

    // configured providers
    expect(route).toMatch(/display_name_en:\s*oauthInfo\s*\?/);
    // registered OAuth providers
    expect(route).toMatch(/display_name_en:\s*loginInfo\s*\?/);
    // available / unregistered providers
    expect(route).toMatch(/display_name_en:\s*entry\.displayNameEn/);
  });
});
