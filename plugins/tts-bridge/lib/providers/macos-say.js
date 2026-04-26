/**
 * macOS say Provider · 本地，无网络依赖
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export function createMacOSSayProvider(_config) {
  return {
    name: "say",
    label: "macOS say (本地)",

    async synthesize({ text, voice, speed, outPath }) {
      if (process.platform !== "darwin") {
        throw new Error("macOS say is only available on macOS");
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const aiffPath = outPath.replace(/\.mp3$/, ".aiff");
      const voiceArg = voice ? `-v "${voice}"` : "";
      const rateArg = speed ? `-r ${Math.round(200 * speed)}` : "";
      execSync(`say ${voiceArg} ${rateArg} -o "${aiffPath}"`, { input: text });
      // convert to mp3 if ffmpeg available
      try {
        execSync(`ffmpeg -y -i "${aiffPath}" -ar 24000 -ac 1 "${outPath}"`, { stdio: "ignore" });
        fs.rmSync(aiffPath, { force: true });
        return { ok: true, provider: "say", path: outPath };
      } catch {
        // fallback: keep aiff
        return { ok: true, provider: "say", path: aiffPath };
      }
    },
  };
}
