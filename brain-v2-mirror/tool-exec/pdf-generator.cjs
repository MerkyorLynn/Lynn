const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function generatePdf({ title = 'Lynn Report', type = 'report', author = 'Lynn', content = [], accent = '#2D5F8A', date } = {}) {
  const id = crypto.randomBytes(4).toString('hex');
  const dir = `/tmp/lynn-pdf-${id}`;
  fs.mkdirSync(dir, { recursive: true });

  const dateStr = date || new Date().toLocaleDateString('zh-CN');
  const blocks = typeof content === 'string'
    ? content.split('\n\n').map((p) => {
        if (p.startsWith('# ')) return { type: 'h1', text: p.slice(2) };
        if (p.startsWith('## ')) return { type: 'h2', text: p.slice(3) };
        if (p.startsWith('### ')) return { type: 'h3', text: p.slice(4) };
        if (p.startsWith('> ')) return { type: 'callout', text: p.replace(/^> /gm, '') };
        if (p.startsWith('- ')) return { type: 'bullets', items: p.split('\n').map((l) => l.replace(/^- /, '')) };
        return { type: 'body', text: p.trim() };
      }).filter((b) => b.text || b.items)
    : content;

  let bodyHtml = '';
  for (const b of blocks || []) {
    const t = b.type || 'body';
    const txt = String(b.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (t === 'h1') bodyHtml += `<h1>${txt}</h1><hr class="accent">`;
    else if (t === 'h2') bodyHtml += `<h2>${txt}</h2>`;
    else if (t === 'h3') bodyHtml += `<h3>${txt}</h3>`;
    else if (t === 'body') bodyHtml += `<p>${txt}</p>`;
    else if (t === 'bullet') bodyHtml += `<ul><li>${txt}</li></ul>`;
    else if (t === 'bullets') bodyHtml += `<ul>${(b.items || []).map((i) => '<li>' + String(i).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>').join('')}</ul>`;
    else if (t === 'callout') bodyHtml += `<div class="callout">${txt}</div>`;
    else if (t === 'code') bodyHtml += `<pre class="code">${txt}</pre>`;
    else if (t === 'divider') bodyHtml += `<hr class="accent">`;
    else if (t === 'table') {
      const h = (b.headers || []).map((c) => `<th>${c}</th>`).join('');
      const r = (b.rows || []).map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
      bodyHtml += `<table><thead><tr>${h}</tr></thead><tbody>${r}</tbody></table>`;
    } else if (t === 'pagebreak') bodyHtml += '<div style="page-break-after:always"></div>';
    else bodyHtml += `<p>${txt}</p>`;
  }

  const safeTitle = String(title || 'Lynn Report').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
@page { size: A4; margin: 25mm 20mm; }
body { font-family: "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 11pt; line-height: 1.8; color: #333; }
.cover { height: 90vh; display: flex; flex-direction: column; justify-content: center; align-items: center; page-break-after: always; }
.cover h1 { font-size: 28pt; color: ${accent}; margin-bottom: 8px; }
.cover .line { width: 120px; height: 3px; background: ${accent}; margin: 16px 0; }
.cover .meta { font-size: 12pt; color: #666; margin-top: 20px; }
h1 { font-size: 18pt; color: ${accent}; margin-top: 24px; }
h2 { font-size: 14pt; color: #333; margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
h3 { font-size: 12pt; color: #444; margin-top: 16px; }
p { text-align: justify; margin: 8px 0; }
hr.accent { border: none; height: 2px; background: ${accent}; margin: 8px 0 16px; }
ul { padding-left: 20px; }
li { margin: 4px 0; }
.callout { background: #f0f4f8; border-left: 4px solid ${accent}; padding: 12px 16px; margin: 12px 0; border-radius: 0 4px 4px 0; }
pre.code { background: #f5f5f5; border-left: 3px solid ${accent}; padding: 12px; font-family: monospace; font-size: 9pt; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 10pt; }
th { background: ${accent}; color: white; padding: 8px 12px; text-align: left; }
td { padding: 6px 12px; border-bottom: 1px solid #ddd; }
tr:nth-child(even) { background: #f8f8f8; }
</style></head><body>
<div class="cover">
  <h1>${safeTitle}</h1>
  <div class="line"></div>
  <div class="meta">${author} | ${dateStr}</div>
</div>
${bodyHtml}
</body></html>`;

  const htmlPath = path.join(dir, 'report.html');
  const pdfPath = path.join(dir, String(title || 'Lynn Report').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_') + '.pdf');
  fs.writeFileSync(htmlPath, html);

  try {
    execSync(`python3 -m weasyprint "${htmlPath}" "${pdfPath}"`, { timeout: 30000, stdio: 'pipe' });
    if (fs.existsSync(pdfPath)) {
      return { path: pdfPath, size: fs.statSync(pdfPath).size, html: htmlPath };
    }
    return { error: 'PDF not created' };
  } catch (e) {
    return { error: e.stderr?.toString().slice(0, 200) || e.message.slice(0, 200) };
  }
}

module.exports = { generatePdf };
