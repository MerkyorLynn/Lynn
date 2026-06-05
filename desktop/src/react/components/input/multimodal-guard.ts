import type { Model } from '../../types';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif']);

export type FileLike = {
  name?: string;
  type?: string;
};

export function isImageLikeName(name?: string | null): boolean {
  if (!name) return false;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function isImageLikeFile(file: FileLike): boolean {
  return !!file.type?.startsWith('image/') || isImageLikeName(file.name);
}

export function modelSupportsVision(model: Pick<Model, 'vision'> | null | undefined): boolean {
  return !!model && model.vision !== false;
}

export function modelDisplayName(model: Pick<Model, 'id' | 'name' | 'provider'> | null | undefined): string {
  if (!model) return '当前模型';
  return String(model.name || model.id || model.provider || '当前模型').trim() || '当前模型';
}

export function formatVisionUnsupportedMessage(modelLabel: string, locale?: string): string {
  const normalized = String(locale || '').toLowerCase();
  if (normalized.startsWith('en')) {
    return `Current model (${modelLabel}) does not support image understanding. Switch to a vision-capable model, or send text only.`;
  }
  if (normalized.startsWith('ja')) {
    return `現在のモデル（${modelLabel}）は画像認識に対応していません。画像対応モデルに切り替えるか、テキストのみ送信してください。`;
  }
  if (normalized.startsWith('ko')) {
    return `현재 모델(${modelLabel})은 이미지 인식을 지원하지 않아요. 비전 지원 모델로 전환하거나 텍스트만 보내 주세요.`;
  }
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk')) {
    return `目前模型（${modelLabel}）不支援圖片識別。請切換到視覺模型，或只傳文字。`;
  }
  return `当前模型（${modelLabel}）不支持图像识别。请切换到视觉模型，或仅发送文字。`;
}
