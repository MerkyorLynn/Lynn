// Brain v2 · tool-exec/create_report
// 深色主题 HTML 报告生成器(metrics/text/table/verdict/warning sections)
// Ported from brain v1 server.js (lines 5199-5299, REPORT_CSS @ line 5198)
import fs from 'fs';
import path from 'path';

const REPORT_CSS = ":root{--bg:#080b14;--s1:#0e1421;--s2:#151e2e;--bd:#1c2640;--t:#e2e8f0;--td:#7b8ca5;--ac:#ef4444;--ac2:#f87171;--grn:#10b981;--amb:#f59e0b;--blu:#3b82f6;--pur:#a78bfa}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--t);font-family:\"Noto Sans SC\",system-ui,sans-serif;line-height:1.7}.c{max-width:1060px;margin:0 auto;padding:36px 20px}.hdr{text-align:center;padding:48px 0 28px;position:relative}.hdr::after{content:\"\";position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:140px;height:2px;background:linear-gradient(90deg,transparent,var(--ac),transparent)}.tag{font-size:12px;color:var(--ac);letter-spacing:4px;font-weight:700}.hdr h1{font-size:30px;font-weight:900;background:linear-gradient(135deg,#fff,var(--ac2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin:6px 0}.hdr .sub{color:var(--td);font-size:13px}.badge{display:inline-block;margin-top:12px;padding:3px 14px;border:1px solid var(--bd);border-radius:16px;font-size:11px;color:var(--td)}.sec{margin:38px 0}.sec-t{font-size:19px;font-weight:700;margin-bottom:16px;padding-left:12px;border-left:3px solid var(--ac);display:flex;align-items:center;gap:8px}.sec-t .n{font-size:11px;color:var(--ac);letter-spacing:2px}.ab{background:var(--s1);border:1px solid var(--bd);border-radius:11px;padding:20px;margin:14px 0}.ab h4{color:var(--ac);font-size:14px;margin-bottom:10px;font-weight:700}.ab p{font-size:13px;line-height:1.8;margin-bottom:7px}table.dt{width:100%;border-collapse:collapse;font-size:13px;margin:12px 0}.dt th{text-align:left;padding:7px 10px;background:var(--s2);color:var(--td);font-weight:500;font-size:11px;letter-spacing:1px;border-bottom:1px solid var(--bd)}.dt td{padding:7px 10px;border-bottom:1px solid var(--bd)}.cg{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:14px 0}.cd{background:var(--s1);border:1px solid var(--bd);border-radius:9px;padding:14px;text-align:center}.cd .lb{font-size:10px;color:var(--td);letter-spacing:1px;margin-bottom:3px}.cd .vl{font-size:22px;font-weight:900}.cd .ch{font-size:11px;margin-top:2px}.up{color:var(--grn)}.dn{color:var(--ac)}.nt-c{color:var(--amb)}.vd{background:linear-gradient(135deg,#150a0a,#1a0e15);border:1px solid var(--ac);border-radius:14px;padding:24px;margin:22px 0;position:relative;overflow:hidden}.vd::before{content:\"\";position:absolute;top:-40%;right:-12%;width:220px;height:220px;background:radial-gradient(circle,rgba(239,68,68,.06),transparent 70%);border-radius:50%}.vd h3{font-size:17px;font-weight:700;color:var(--ac2);margin-bottom:12px}.vd-g{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}@media(max-width:640px){.vd-g{grid-template-columns:1fr}}.vd-i{padding:12px;background:rgba(255,255,255,.02);border-radius:8px;border:1px solid rgba(239,68,68,.1)}.vd-i .pr{font-size:11px;color:var(--ac);font-weight:700;letter-spacing:2px;margin-bottom:4px}.vd-i .rg{font-size:19px;font-weight:900;margin-bottom:3px}.vd-i .nt{font-size:12px;color:var(--td);line-height:1.5}.warn{background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:16px;margin:14px 0}.warn h4{color:var(--ac);font-size:13px;font-weight:800;margin-bottom:8px}.warn p{font-size:12px;color:var(--ac2);line-height:1.7;margin-bottom:5px}.disc{margin-top:44px;padding:16px;border-top:1px solid var(--bd);font-size:11px;color:var(--td);line-height:1.8;text-align:center}";

export async function createReport(args, { log } = {}) {
  try {
    const title = args?.title || '分析报告';
    const tag = args?.tag || '';
    const subtitle = args?.subtitle || '';
    const date = args?.date || new Date().toLocaleDateString('zh-CN');
    const sections = args?.sections || [];
    const disclaimer = args?.disclaimer || '本报告基于公开信息整理,不构成任何投资建议,请审慎决策。';

    function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function bold(s) { return String(s || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }
    function dirCls(d) { return d === 'up' ? 'up' : d === 'down' ? 'dn' : 'nt-c'; }
    function nl2p(s) { return bold(esc(s)).split(/\n+/).filter(Boolean).map((p) => '<p>' + p + '</p>').join(''); }

    let body = '';
    body += '<div class="hdr">';
    if (tag) body += '<div class="tag">' + esc(tag) + '</div>';
    body += '<h1>' + esc(title) + '</h1>';
    if (subtitle) body += '<div class="sub">' + esc(subtitle) + '</div>';
    body += '<div class="badge">报告日期：' + esc(date) + '</div></div>';

    sections.forEach((sec, i) => {
      const num = String(i + 1).padStart(2, '0');
      if (sec.type === 'warning') {
        body += '<div class="warn"><h4>⚠ ' + esc(sec.title) + '</h4>' + nl2p(sec.content || '') + '</div>';
        return;
      }
      body += '<div class="sec"><div class="sec-t"><span class="n">' + num + '</span> ' + esc(sec.title) + '</div>';

      if (sec.type === 'metrics' && Array.isArray(sec.metrics)) {
        body += '<div class="cg">';
        for (const m of sec.metrics) {
          const d = dirCls(m.direction);
          body += '<div class="cd"><div class="lb">' + esc(m.label) + '</div><div class="vl ' + d + '">' + esc(m.value) + '</div>';
          if (m.change) body += '<div class="ch ' + d + '">' + esc(m.change) + '</div>';
          body += '</div>';
        }
        body += '</div>';
      }

      if (sec.type === 'text') {
        if (Array.isArray(sec.blocks) && sec.blocks.length) {
          for (const b of sec.blocks) {
            body += '<div class="ab">';
            if (b.heading) body += '<h4>▎' + esc(b.heading) + '</h4>';
            body += nl2p(b.text || '');
            body += '</div>';
          }
        } else if (sec.content) {
          body += '<div class="ab">' + nl2p(sec.content) + '</div>';
        }
      }

      if (sec.type === 'table' && Array.isArray(sec.headers)) {
        body += '<div class="ab"><table class="dt"><tr>';
        for (const h of sec.headers) body += '<th>' + esc(h) + '</th>';
        body += '</tr>';
        for (const row of (sec.rows || [])) {
          body += '<tr>';
          for (const cell of row) {
            const isUp = /涨|增|\+|扭亏/.test(cell);
            const isDn = /跌|降|亏|-/.test(cell);
            body += '<td class="' + (isUp ? 'up' : isDn ? 'dn' : '') + '">' + esc(cell) + '</td>';
          }
          body += '</tr>';
        }
        body += '</table></div>';
      }

      if (sec.type === 'verdict' && Array.isArray(sec.items)) {
        body += '<div class="vd"><h3>走势预判</h3><div class="vd-g">';
        for (const it of sec.items) {
          body += '<div class="vd-i"><div class="pr">' + esc(it.period) + '</div><div class="rg">' + esc(it.range) + '</div><div class="nt">' + esc(it.note) + '</div></div>';
        }
        body += '</div></div>';
      }

      body += '</div>';
    });

    body += '<div class="disc">' + esc(disclaimer) + '</div>';

    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>' + esc(title) + '</title><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700;900&display=swap" rel="stylesheet"><style>' + REPORT_CSS + '</style></head><body><div class="c">' + body + '</div></body></html>';

    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
    const filename = safeTitle + '-' + Date.now() + '.html';
    const outDir = process.env.LOBSTER_PUBLIC_DOWNLOADS || '/opt/lobster-brain/public/downloads';
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, filename), html, 'utf-8');
    const baseUrl = process.env.LOBSTER_DOWNLOAD_BASE_URL || 'https://download.merkyorlynn.com/downloads';
    const downloadUrl = baseUrl + '/' + encodeURIComponent(filename);
    log && log('info', 'tool-exec/create_report', 'created ' + filename + ' (' + sections.length + ' sections)');
    return JSON.stringify({
      success: true,
      title,
      sections: sections.length,
      download_url: downloadUrl,
      message: '\n\n---\n📋 **' + title + '**\n\n' + sections.length + ' 个章节深度分析报告已生成\n\n[📥 点击查看完整报告](' + downloadUrl + ')\n\n---',
    });
  } catch (err) {
    log && log('error', 'tool-exec/create_report', 'create failed: ' + err.message);
    return JSON.stringify({ error: 'Report generation failed: ' + err.message });
  }
}
