/**
 * v0.77 组件视觉测试页
 *
 * 启用方式 (主 App 启动后):
 *   1. dev-mock-sw 已加载 (VITE_USE_MSW=true npm run dev:renderer)
 *   2. URL 加 ?v077-demo (or 直接 import 这个组件渲染)
 *   3. 立刻能看到 PressToTalkButton + MemoryUsedBadge 在 mock 数据下工作
 *
 * 真实场景集成时:
 *   • PressToTalkButton: 嵌入主输入框旁
 *   • MemoryUsedBadge: 嵌入每条 Lynn 回复的上方
 *   这个文件可以直接删除
 */
import { useState } from 'react';
import { PressToTalkButton } from './voice/PressToTalkButton';
import { MemoryUsedBadge, type MemoryItem } from './memory/MemoryUsedBadge';

export function V077Demo() {
  const [transcribed, setTranscribed] = useState<string>('');
  const [memUsed, setMemUsed] = useState<MemoryItem[]>([]);
  const [memQuery, setMemQuery] = useState('');
  const [memLoading, setMemLoading] = useState(false);

  // 调真实 (mock) 后端: /v1/memory/recall
  const testMemoryRecall = async () => {
    setMemLoading(true);
    try {
      const r = await fetch('/api/v1/memory/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: memQuery, top_k: 5 }),
      });
      const data = await r.json();
      setMemUsed(data.hits ?? []);
    } catch (e) {
      console.error('recall fail', e);
    } finally {
      setMemLoading(false);
    }
  };

  return (
    <div style={styles.root}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Lynn v0.77 · 组件视觉测试</h1>
        <p style={styles.subtitle}>
          mock SW {import.meta.env.VITE_USE_MSW === 'true' ? '✅ 启用' : '⚠️ 未启用 (set VITE_USE_MSW=true)'}
          {' · '}
          mode: {import.meta.env.DEV ? 'dev' : 'prod'}
        </p>
      </header>

      {/* === PressToTalkButton === */}
      <section style={styles.section}>
        <h2 style={styles.h2}>🎤 PressToTalkButton</h2>
        <p style={styles.hint}>按住按钮说话(mock 模式 1 秒后返回固定文本),松开看转写结果</p>

        <div style={styles.row}>
          <PressToTalkButton
            mockMode={false}
            onTranscribed={(text) => setTranscribed(text)}
          />
          <div style={styles.output}>
            <strong>转写结果:</strong>
            <div style={styles.code}>{transcribed || '(等待录音)'}</div>
          </div>
        </div>
      </section>

      {/* === MemoryUsedBadge === */}
      <section style={styles.section}>
        <h2 style={styles.h2}>💡 MemoryUsedBadge</h2>
        <p style={styles.hint}>
          调 /v1/memory/recall (mock 数据) → 渲染 chip → 点击展开看引用
        </p>

        <div style={styles.row}>
          <input
            value={memQuery}
            onChange={(e) => setMemQuery(e.target.value)}
            placeholder="试试: vllm / MoE / GPU"
            style={styles.input}
          />
          <button onClick={testMemoryRecall} disabled={memLoading} style={styles.btn}>
            {memLoading ? '召回中...' : '召回记忆'}
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <MemoryUsedBadge
            items={memUsed}
            recallMs={28}
            defaultExpanded
            onJumpToSource={(item) => alert(`跳转到原文: id=${item.id}\n${item.text}`)}
            onDismiss={(item) =>
              setMemUsed((arr) => arr.filter((x) => x.id !== item.id))
            }
          />
        </div>
      </section>

      {/* === API smoke test === */}
      <section style={styles.section}>
        <h2 style={styles.h2}>🧪 API 烟囱测试</h2>
        <p style={styles.hint}>验证 mock SW 拦截了所有 v0.77 endpoints</p>
        <SmokeTests />
      </section>
    </div>
  );
}

function SmokeTests() {
  const [results, setResults] = useState<Record<string, string>>({});

  const tests: Array<[string, () => Promise<unknown>]> = [
    ['POST /v1/memory/recall', () =>
      fetch('/api/v1/memory/recall', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test' }),
      }).then((r) => r.json()),
    ],
    ['POST /v1/memory/write', () =>
      fetch('/api/v1/memory/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hi', layer: 'L4', source: 'manual' }),
      }).then((r) => r.json()),
    ],
    ['GET /v1/memory/list', () =>
      fetch('/api/v1/memory/list?limit=10').then((r) => r.json()),
    ],
    ['GET /v1/knowledge/list', () =>
      fetch('/api/v1/knowledge/list').then((r) => r.json()),
    ],
  ];

  const runAll = async () => {
    setResults({});
    for (const [name, fn] of tests) {
      try {
        const data = await fn();
        setResults((r) => ({ ...r, [name]: '✅ ' + JSON.stringify(data).slice(0, 80) }));
      } catch (e) {
        setResults((r) => ({ ...r, [name]: '❌ ' + (e as Error).message }));
      }
    }
  };

  return (
    <>
      <button onClick={runAll} style={styles.btn}>跑 4 个 endpoint</button>
      <ul style={styles.results}>
        {tests.map(([name]) => (
          <li key={name}>
            <code>{name}</code>: {results[name] ?? '(未跑)'}
          </li>
        ))}
      </ul>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    background: '#0d1117', color: '#e6edf3', minHeight: '100vh',
    padding: '32px', fontFamily: 'ui-sans-serif, system-ui',
  },
  header: { borderBottom: '1px solid #30363d', paddingBottom: 16, marginBottom: 24 },
  h1: { margin: 0, fontSize: 24, color: '#e6edf3' },
  subtitle: { margin: '6px 0 0', color: '#8b949e', fontSize: 13 },
  section: {
    background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
    padding: 20, marginBottom: 20,
  },
  h2: { margin: '0 0 6px', fontSize: 16, color: '#e6edf3' },
  hint: { color: '#8b949e', fontSize: 12, margin: '0 0 16px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  input: {
    flex: 1, minWidth: 240, padding: '8px 12px',
    background: '#0d1117', color: '#e6edf3',
    border: '1px solid #30363d', borderRadius: 6, fontSize: 13,
  },
  btn: {
    background: '#238636', color: 'white', border: 'none',
    padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
  },
  output: { flex: 1, minWidth: 240 },
  code: {
    background: '#0d1117', padding: 10, borderRadius: 6,
    fontFamily: 'ui-monospace, monospace', fontSize: 13,
    border: '1px solid #30363d', minHeight: 24,
  },
  results: {
    listStyle: 'none', padding: 0, marginTop: 12,
    fontSize: 12, fontFamily: 'ui-monospace, monospace',
  },
};
