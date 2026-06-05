/**
 * visual-format.ts — pure display helpers for a vision worker's structured
 * result (worker.visual_result). Coordinates are normalized [0,1] (see the v0.80
 * decision), rendered as percentages. Pure + testable (no DOM, mirrors the
 * buildFleetDispatchPayload pattern).
 */
import type { FleetVisualBox, FleetVisualResultFile } from '../../../../../shared/fleet-events.js';

function pct(v: number | undefined): string {
  return `${Math.round((v ?? 0) * 100)}%`;
}

/** "label @ 12%,8% · 30%×10% · 87% conf" from a normalized grounding box. */
export function formatVisualBox(box: FleetVisualBox, index: number): string {
  const label = box.label || `box ${index + 1}`;
  let out = `${label} @ ${pct(box.x)},${pct(box.y)}`;
  if (box.width != null && box.height != null) out += ` · ${pct(box.width)}×${pct(box.height)}`;
  if (box.confidence != null) out += ` · ${pct(box.confidence)} conf`;
  return out;
}

export type VisualFileKind = 'created' | 'modified' | 'suggested';
export const VISUAL_FILE_KINDS: VisualFileKind[] = ['created', 'modified', 'suggested'];

/** Group result file paths by kind (created / modified / suggested), preserving order. */
export function groupVisualFiles(files: FleetVisualResultFile[]): Record<VisualFileKind, string[]> {
  const out: Record<VisualFileKind, string[]> = { created: [], modified: [], suggested: [] };
  for (const f of files) {
    if (f.kind === 'created' || f.kind === 'modified' || f.kind === 'suggested') out[f.kind].push(f.path);
  }
  return out;
}

export function visualImageSrc(image: string | null | undefined): string | null {
  const raw = String(image || '').trim();
  if (!raw) return null;
  if (/^(https?:|data:image\/|file:\/\/)/i.test(raw)) return raw;
  if (!raw.startsWith('/')) return null;
  return `file://${raw.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

export function visualBoxStyle(box: FleetVisualBox): Record<'left' | 'top' | 'width' | 'height', string> {
  return {
    left: `${clamp01(box.x) * 100}%`,
    top: `${clamp01(box.y) * 100}%`,
    width: `${clamp01(box.width ?? 0.04) * 100}%`,
    height: `${clamp01(box.height ?? 0.04) * 100}%`,
  };
}

function clamp01(value: number | undefined): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? Number(value) : 0));
}
