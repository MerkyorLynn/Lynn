/**
 * MemoryUsedBadge · "💡 引用了 N 条历史" · v0.77
 *
 * 用法:
 *   const [memUsed, setMemUsed] = useState<MemoryItem[]>([]);
 *   // 在 chat SSE 解析里:
 *   if (event.type === "memory_used") setMemUsed(event.items);
 *
 *   <MemoryUsedBadge
 *     items={memUsed}
 *     onJumpToSource={(item) => navigate(`/memory/${item.id}`)}
 *     defaultExpanded={false}
 *   />
 *
 * 接口对齐 openapi-v0.77.yaml:
 *   chat SSE 首帧 {"type":"memory_used","items":[...]}
 *
 * 设计:
 *   • 折叠态: 一行 chip "💡 引用 3 条历史 · 24ms"
 *   • 展开态: 卡片列表,每条显示 snippet + source + 时间 + 跳转
 */
import { useState } from "react";

// ============ Types (跟 OpenAPI MemoryItem 对齐) ============
export interface MemoryItem {
  id: number;
  text: string;
  layer: "L1" | "L2" | "L3" | "L4" | "L5" | "L6";
  source: "chat" | "note" | "doc" | "voice" | "code" | "web" | "manual";
  timestamp: number;
  score: number;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryUsedBadgeProps {
  items: MemoryItem[];
  recallMs?: number;
  defaultExpanded?: boolean;
  onJumpToSource?: (item: MemoryItem) => void;
  onDismiss?: (item: MemoryItem) => void;
  className?: string;
}

// ============ Component ============
export function MemoryUsedBadge({
  items,
  recallMs,
  defaultExpanded = false,
  onJumpToSource,
  onDismiss,
  className = "",
}: MemoryUsedBadgeProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!items || items.length === 0) return null;

  return (
    <div className={`mub-root ${className}`}>
      <button
        type="button"
        className="mub-chip"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="mub-chip-icon">💡</span>
        <span className="mub-chip-text">
          引用了 <strong>{items.length}</strong> 条历史
        </span>
        {recallMs != null && (
          <span className="mub-chip-meta">· {recallMs}ms</span>
        )}
        <span className={`mub-chip-arrow ${expanded ? "open" : ""}`}>▾</span>
      </button>

      {expanded && (
        <ul className="mub-list" role="list">
          {items.map((item, idx) => (
            <li key={item.id} className="mub-item">
              <div className="mub-item-head">
                <span className="mub-rank">#{idx + 1}</span>
                <SourceBadge source={item.source} />
                <LayerBadge layer={item.layer} />
                <span className="mub-time">{formatTime(item.timestamp)}</span>
                <span className="mub-score" title={`相关度 ${(item.score * 100).toFixed(0)}%`}>
                  {(item.score * 100).toFixed(0)}%
                </span>
                {onDismiss && (
                  <button
                    type="button"
                    className="mub-dismiss"
                    onClick={() => onDismiss(item)}
                    aria-label="忽略此记忆"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="mub-item-body">
                <Snippet text={item.snippet ?? item.text} />
              </div>
              {onJumpToSource && (
                <div className="mub-item-actions">
                  <button
                    type="button"
                    className="mub-jump"
                    onClick={() => onJumpToSource(item)}
                  >
                    查看原文 →
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============ 子组件 ============
function SourceBadge({ source }: { source: MemoryItem["source"] }) {
  const map: Record<string, { icon: string; label: string; color: string }> = {
    chat:   { icon: "💬", label: "对话",   color: "#58a6ff" },
    note:   { icon: "📝", label: "笔记",   color: "#3fb950" },
    doc:    { icon: "📄", label: "文档",   color: "#bc8cff" },
    voice:  { icon: "🎙️", label: "语音",   color: "#f78166" },
    code:   { icon: "⌨️", label: "代码",   color: "#79c0ff" },
    web:    { icon: "🌐", label: "网页",   color: "#d29922" },
    manual: { icon: "✋", label: "手动",   color: "#8b949e" },
  };
  const cfg = map[source] ?? map.manual;
  return (
    <span className="mub-badge" style={{ borderColor: cfg.color, color: cfg.color }}>
      <span aria-hidden>{cfg.icon}</span> {cfg.label}
    </span>
  );
}

function LayerBadge({ layer }: { layer: MemoryItem["layer"] }) {
  const desc: Record<string, string> = {
    L1: "瞬时", L2: "会话", L3: "短期", L4: "中期", L5: "长期", L6: "永久",
  };
  return (
    <span className="mub-layer" title={`${layer} · ${desc[layer]}记忆`}>
      {layer}
    </span>
  );
}

function Snippet({ text }: { text: string }) {
  // 自动截断 + "更多"展开
  const [showFull, setShowFull] = useState(false);
  const MAX = 200;
  if (text.length <= MAX || showFull) {
    return (
      <p className="mub-snippet">
        {text}
        {showFull && text.length > MAX && (
          <button className="mub-toggle" onClick={() => setShowFull(false)}>
            收起
          </button>
        )}
      </p>
    );
  }
  return (
    <p className="mub-snippet">
      {text.slice(0, MAX)}…
      <button className="mub-toggle" onClick={() => setShowFull(true)}>
        展开
      </button>
    </p>
  );
}

// ============ helpers ============
function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ============ 默认样式 ============
const style = `
.mub-root { margin: 8px 0; font-size: 13px; }
.mub-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: #161b22; color: #e6edf3; border: 1px solid #30363d;
  border-radius: 999px; padding: 4px 12px; cursor: pointer;
  font-size: 12px; transition: background 120ms;
}
.mub-chip:hover { background: #21262d; border-color: #58a6ff; }
.mub-chip-icon { font-size: 14px; }
.mub-chip-text strong { color: #58a6ff; }
.mub-chip-meta { color: #8b949e; font-size: 11px; }
.mub-chip-arrow { transition: transform 120ms; color: #8b949e; }
.mub-chip-arrow.open { transform: rotate(180deg); }

.mub-list {
  list-style: none; padding: 0; margin: 8px 0 0 0;
  border: 1px solid #30363d; border-radius: 8px; overflow: hidden;
  background: #0d1117;
}
.mub-item { padding: 10px 14px; border-bottom: 1px solid #21262d; }
.mub-item:last-child { border-bottom: none; }
.mub-item-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-bottom: 6px;
}
.mub-rank { color: #6e7681; font-weight: 700; font-size: 11px; }
.mub-badge {
  display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid; border-radius: 4px; padding: 1px 6px;
  font-size: 11px; font-weight: 600;
}
.mub-layer {
  background: #21262d; color: #8b949e; border-radius: 4px;
  padding: 1px 6px; font-size: 10px; font-family: ui-monospace, monospace;
}
.mub-time { color: #8b949e; font-size: 11px; }
.mub-score {
  margin-left: auto; color: #3fb950; font-weight: 700; font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.mub-dismiss {
  background: transparent; border: none; color: #6e7681;
  cursor: pointer; padding: 0 4px; font-size: 16px; line-height: 1;
}
.mub-dismiss:hover { color: #f85149; }
.mub-snippet { color: #c9d1d9; line-height: 1.5; margin: 0; font-size: 12.5px; }
.mub-toggle {
  background: transparent; border: none; color: #58a6ff; cursor: pointer;
  padding: 0 4px; font-size: 12px;
}
.mub-toggle:hover { text-decoration: underline; }
.mub-item-actions { margin-top: 6px; }
.mub-jump {
  background: transparent; border: 1px solid #30363d; color: #58a6ff;
  border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer;
}
.mub-jump:hover { background: #161b22; border-color: #58a6ff; }
`;
if (typeof document !== "undefined" && !document.querySelector("style[data-mub]")) {
  const el = document.createElement("style");
  el.setAttribute("data-mub", "");
  el.textContent = style;
  document.head.appendChild(el);
}
