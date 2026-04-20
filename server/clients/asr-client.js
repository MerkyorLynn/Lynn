/**
 * faster-whisper ASR client · v0.77
 */
const ASR_URL = process.env.LYNN_ASR_URL || "http://localhost:8004";

export async function transcribe(audioBuffer, { language = "zh", filename = "audio.webm" } = {}) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), filename);
  form.append("language", language);
  form.append("response_format", "json");

  const res = await fetch(`${ASR_URL}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`transcribe failed: HTTP ${res.status}`);
  return await res.json(); // { text, language, duration }
}

export async function asrHealth() {
  try {
    const r = await fetch(`${ASR_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
