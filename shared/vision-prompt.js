const IMAGE_ONLY_MARKERS = new Set([
  "（看图）",
  "(看图)",
  "看图",
  "(view image)",
  "view image",
  "（画像を見る）",
  "(画像を見る)",
  "이미지 보기",
  "(이미지 보기)",
]);

function isZhLocale(locale = "zh") {
  return String(locale || "").toLowerCase().startsWith("zh");
}

function defaultVisionPrompt(locale = "zh") {
  return isZhLocale(locale)
    ? "请分析这张图片，提取主要内容，并用一段文字做总结。"
    : "Please analyze this image, extract the main content, and summarize it in one paragraph.";
}

function senderOnlyPrefix(text) {
  const raw = String(text || "");
  const zh = raw.match(/^(\[来自 [^\]]+\])\s*$/);
  if (zh) return zh[1];
  const en = raw.match(/^(\[From [^\]]+\])\s*$/i);
  if (en) return en[1];
  return "";
}

export function hasVisionImages(images) {
  return Array.isArray(images) && images.length > 0;
}

export function normalizeVisionPromptText(text, images, opts = {}) {
  if (!hasVisionImages(images)) return String(text || "");
  const locale = opts.locale || "zh";
  const raw = String(text || "");
  const trimmed = raw.trim();
  const prompt = defaultVisionPrompt(locale);
  if (!trimmed) return prompt;

  const prefix = senderOnlyPrefix(raw);
  if (prefix) return `${prefix} ${prompt}`;

  if (IMAGE_ONLY_MARKERS.has(trimmed.toLowerCase()) || IMAGE_ONLY_MARKERS.has(trimmed)) {
    return prompt;
  }
  return raw;
}

export function buildVisionUnsupportedMessage(opts = {}) {
  return isZhLocale(opts.locale || "zh")
    ? "我收到了图片，但当前模型不支持视觉输入，无法可靠识别图片内容。请切换到支持图片的模型，或重新发送图片并附上需要我看的重点。"
    : "I received the image, but the current model does not support vision input, so I cannot reliably inspect it. Please switch to a vision-capable model or resend the image with the details you want checked.";
}

export function buildVisionEmptyFallbackText(opts = {}) {
  return isZhLocale(opts.locale || "zh")
    ? "这次图片没有被模型可靠识别到，Lynn 已结束空转以免卡住会话。请重新上传图片，或把图片文件路径发来；如果是截图，也可以补一句你希望我重点看哪里。"
    : "The image was not reliably processed by the model, so Lynn ended this empty turn to avoid locking the conversation. Please upload the image again or send its file path, and optionally describe what you want me to focus on.";
}
