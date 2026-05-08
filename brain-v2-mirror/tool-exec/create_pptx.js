// Brain v2 · tool-exec/create_pptx
// 专业深色主题 PPTX(title/section/two_column/content layouts) — pptxgenjs
// Ported from brain v1 server.js (lines 5324-5450)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function createPptx(args, { log } = {}) {
  try {
    const PptxGenJS = require('pptxgenjs');
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE';
    pres.title = args?.title || 'Presentation';
    if (args?.author) pres.author = args.author;

    const THEME = {
      bg: '0B1120', bgLight: '111B2E', accent: 'EF4444', accent2: 'F87171',
      green: '10B981', amber: 'F59E0B', blue: '3B82F6', purple: 'A78BFA',
      text: 'E2E8F0', textDim: '7B8CA5', border: '1C2640',
    };

    function parseItems(body) {
      return (body || '')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          const m = l.match(/^\s*[-*]\s+(.+)/);
          return m
            ? { text: m[1].trim(), options: { bullet: { code: '2022' }, fontSize: 15, color: THEME.text, lineSpacingMultiple: 1.5, paraSpaceBefore: 4 } }
            : { text: l.trim(), options: { fontSize: 15, color: THEME.text, lineSpacingMultiple: 1.5, paraSpaceBefore: 4 } };
        });
    }

    function addFooter(slide, num, total) {
      slide.addText(String(num) + ' / ' + String(total), {
        x: 11.5, y: 6.9, w: 1.5, h: 0.3, fontSize: 9, color: THEME.textDim, align: 'right',
      });
    }

    const slides = args?.slides || [];
    const totalSlides = slides.length;

    for (let si = 0; si < slides.length; si++) {
      const s = slides[si];
      const layout = s.layout || 'content';
      const slide = pres.addSlide();

      if (layout === 'title') {
        slide.background = { color: THEME.bg };
        slide.addShape('rect', { x: 0, y: 0, w: '100%', h: '100%', fill: { color: THEME.bg } });
        slide.addShape('rect', { x: 3.5, y: 1.6, w: 6, h: 0.04, fill: { color: THEME.accent } });
        slide.addText(s.title || '', { x: 1.0, y: 1.8, w: 11, h: 1.6, fontSize: 38, bold: true, color: 'FFFFFF', align: 'center', fontFace: 'Microsoft YaHei' });
        if (s.body) slide.addText(s.body, { x: 1.5, y: 3.6, w: 10, h: 0.8, fontSize: 18, color: THEME.textDim, align: 'center', fontFace: 'Microsoft YaHei' });
        slide.addShape('rect', { x: 3.5, y: 4.6, w: 6, h: 0.04, fill: { color: THEME.accent } });
        addFooter(slide, si + 1, totalSlides);
      } else if (layout === 'section') {
        slide.background = { color: '0D1526' };
        slide.addShape('rect', { x: 4.5, y: 3.0, w: 4, h: 0.03, fill: { color: THEME.accent } });
        slide.addText(s.title || '', { x: 1.0, y: 3.2, w: 11, h: 1.2, fontSize: 32, bold: true, color: THEME.accent2, align: 'center', fontFace: 'Microsoft YaHei' });
        if (s.body) slide.addText(s.body, { x: 2.0, y: 4.5, w: 9, h: 0.6, fontSize: 16, color: THEME.textDim, align: 'center', fontFace: 'Microsoft YaHei' });
        addFooter(slide, si + 1, totalSlides);
      } else if (layout === 'two_column') {
        slide.background = { color: THEME.bg };
        slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.9, fill: { color: THEME.bgLight } });
        slide.addText(s.title || '', { x: 0.6, y: 0.15, w: 11.5, h: 0.6, fontSize: 22, bold: true, color: 'FFFFFF', fontFace: 'Microsoft YaHei' });
        slide.addShape('rect', { x: 0.6, y: 0.9, w: 11.8, h: 0.025, fill: { color: THEME.accent } });
        slide.addShape('line', { x: 6.5, y: 1.2, w: 0, h: 5.0, line: { color: THEME.border, width: 1 } });
        const sep = (s.body || '').includes('|||') ? '|||' : '---';
        const parts = (s.body || '').split(sep);
        slide.addText(parseItems(parts[0]), { x: 0.6, y: 1.3, w: 5.5, h: 5.0, valign: 'top', fontFace: 'Microsoft YaHei' });
        if (parts[1]) slide.addText(parseItems(parts[1]), { x: 6.9, y: 1.3, w: 5.5, h: 5.0, valign: 'top', fontFace: 'Microsoft YaHei' });
        addFooter(slide, si + 1, totalSlides);
      } else {
        // content (default)
        slide.background = { color: THEME.bg };
        slide.addShape('rect', { x: 0, y: 0, w: '100%', h: 0.9, fill: { color: THEME.bgLight } });
        slide.addText(s.title || '', { x: 0.6, y: 0.15, w: 11.5, h: 0.6, fontSize: 22, bold: true, color: 'FFFFFF', fontFace: 'Microsoft YaHei' });
        slide.addShape('rect', { x: 0.6, y: 0.9, w: 11.8, h: 0.025, fill: { color: THEME.accent } });
        if (s.body) {
          slide.addText(parseItems(s.body), { x: 0.6, y: 1.3, w: 11.8, h: 5.2, valign: 'top', fontFace: 'Microsoft YaHei' });
        }
        addFooter(slide, si + 1, totalSlides);
      }
      if (s.notes) slide.addNotes(s.notes);
    }

    const safeTitle = (args?.title || 'presentation').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
    const filename = safeTitle + '-' + Date.now() + '.pptx';
    const outDir = process.env.LOBSTER_PUBLIC_DOWNLOADS || '/opt/lobster-brain/public/downloads';
    fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, filename);
    const buffer = await pres.write({ outputType: 'nodebuffer' });
    fs.writeFileSync(filePath, buffer);
    const baseUrl = process.env.LOBSTER_DOWNLOAD_BASE_URL || 'https://download.merkyorlynn.com/downloads';
    const downloadUrl = baseUrl + '/' + encodeURIComponent(filename);
    log && log('info', 'tool-exec/create_pptx', 'created ' + filename + ' (' + slides.length + ' slides)');
    return JSON.stringify({
      success: true,
      title: args?.title,
      slides: slides.length,
      download_url: downloadUrl,
      message: '\n\n---\n📊 **' + (args?.title || '演示文稿') + '**\n\n' + slides.length + ' 页专业演示文稿已生成\n\n[📥 点击下载 PPTX](' + downloadUrl + ')\n\n---',
    });
  } catch (err) {
    log && log('error', 'tool-exec/create_pptx', 'create failed: ' + err.message);
    return JSON.stringify({ error: 'PPTX generation failed: ' + err.message });
  }
}
