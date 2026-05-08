// Brain v2 · tool-exec/web_fetch
// HTTP fetch + HTML strip,15s timeout,默认截断 8000 chars
const STRIP_PATTERNS = [
  [/<script[^>]*>[\s\S]*?<\/script>/gi, ''],
  [/<style[^>]*>[\s\S]*?<\/style>/gi, ''],
  [/<[^>]+>/g, ' '],
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'], [/&gt;/g, '>'], [/&amp;/g, '&'],
  [/\s+/g, ' '],
];

export async function webFetch(url, maxLength = 8000, { log } = {}) {
  if (!url || typeof url !== 'string') return JSON.stringify({ error: 'invalid URL' });
  let target = url.trim();
  if (!target.startsWith('http')) target = 'https://' + target;
  log && log('info', 'tool-exec/web_fetch ' + target);
  try {
    const resp = await fetch(target, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status });
    const ctype = resp.headers.get('content-type') || '';
    let text;
    if (ctype.includes('application/json')) {
      text = JSON.stringify(await resp.json(), null, 2);
    } else {
      text = await resp.text();
      for (const [re, rep] of STRIP_PATTERNS) text = text.replace(re, rep);
      text = text.trim();
    }
    if (text.length > maxLength) text = text.slice(0, maxLength) + '\n... (truncated)';
    return text || JSON.stringify({ error: 'empty response' });
  } catch (e) {
    log && log('warn', 'tool-exec/web_fetch error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}
