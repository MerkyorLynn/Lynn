/**
 * macOS say Provider · 本地，无网络依赖
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export function createMacOSSayProvider(_config) {
  return {
    name: "say",
    label: "macOS say (本地)",

    async synthesize({ text, voice, speed, outPath }) {
      if (process.platform !== "darwin") {
        throw new Error("macOS say is only available on macOS");
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const parsed = path.parse(outPath);
      const aiffPath = path.join(parsed.dir, `${parsed.name}.aiff`);
      const sayArgs = [];
      if (voice) sayArgs.push("-v", voice);
      if (speed) sayArgs.push("-r", String(Math.round(200 * speed)));
      sayArgs.push("-o", aiffPath, text);
      execFileSync("say", sayArgs);

      // Prefer a real WAV fallback. Lynn's renderer can decode WAV reliably, while
      // say cannot write WAV directly just because the output filename ends in .wav.
      try {
        execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", "-c", "1", aiffPath, outPath], { stdio: "ignore" });
        fs.rmSync(aiffPath, { force: true });
        return { ok: true, provider: "say", path: outPath };
      } catch {
        try {
          execFileSync("ffmpeg", ["-y", "-i", aiffPath, "-ar", "22050", "-ac", "1", outPath], { stdio: "ignore" });
          fs.rmSync(aiffPath, { force: true });
          return { ok: true, provider: "say", path: outPath };
        } catch {
          // Last resort: keep AIFF instead of failing the whole TTS chain.
          return { ok: true, provider: "say", path: aiffPath };
        }
      }
    },
  };
}
