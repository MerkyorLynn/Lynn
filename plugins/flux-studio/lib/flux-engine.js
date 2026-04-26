/**
 * flux-engine.js — 图像生成引擎
 *
 * 支持 provider：
 * - siliconflow：调用 SiliconFlow FLUX API
 * - openai：DALL-E
 * - local-comfyui：ComfyUI HTTP 接口
 */

import fs from "fs";

async function fetchImage(url, body, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function generateImage({ prompt, width, height, style, seed, config }) {
  const provider = config?.provider || "siliconflow";
  const apiKey = config?.api_key || "";
  const endpoint = config?.endpoint || "";

  let imageUrl = null;
  let imageBase64 = null;

  if (provider === "siliconflow") {
    const url = "https://api.siliconflow.cn/v1/images/generations";
    const body = {
      model: "black-forest-labs/FLUX.1-schnell",
      prompt: style ? `${prompt}, ${style}` : prompt,
      image_size: `${width}x${height}`,
      seed: seed >= 0 ? seed : undefined,
    };
    const data = await fetchImage(url, body, apiKey);
    imageUrl = data.images?.[0]?.url;
    imageBase64 = data.images?.[0]?.url; // siliconflow 返回的是 data URL
  } else if (provider === "openai") {
    const url = "https://api.openai.com/v1/images/generations";
    const body = {
      model: "dall-e-3",
      prompt: style ? `${prompt}, ${style}` : prompt,
      size: `${width}x${height}`,
      response_format: "b64_json",
    };
    const data = await fetchImage(url, body, apiKey);
    imageBase64 = `data:image/png;base64,${data.data?.[0]?.b64_json}`;
  } else if (provider === "local-comfyui" && endpoint) {
    // PoC：直接返回占位，ComfyUI 接入需要构建 workflow JSON
    throw new Error("local-comfyui provider is not yet implemented in PoC");
  }

  if (!imageUrl && !imageBase64) {
    throw new Error("No image returned from provider");
  }

  // fetch actual bytes
  const fetchUrl = imageBase64?.startsWith("data:") ? imageBase64 : imageUrl;
  if (fetchUrl.startsWith("data:")) {
    const base64 = fetchUrl.split(",")[1];
    return Buffer.from(base64, "base64");
  }
  const imgRes = await fetch(fetchUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}
