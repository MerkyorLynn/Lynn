// Brain v2 · tool-exec/create_pdf
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pdfGenerator;
try {
  pdfGenerator = require('./pdf-generator.cjs');
} catch {
  // Production brain-v2 can still share the v1 generator while we transition.
  pdfGenerator = require('/opt/lobster-brain/pdf-generator.js');
}

const DOWNLOAD_BASE_URL = process.env.LOBSTER_DOWNLOAD_BASE_URL || 'https://download.merkyorlynn.com/downloads';

export async function createPdf(args, { log } = {}) {
  log && log('info', 'tool-exec/create_pdf ' + (args?.title || 'untitled'));
  try {
    const result = await pdfGenerator.generatePdf(args || {});
    if (result.error) return JSON.stringify({ error: result.error });
    // brain v1 returns { path, size, html? }
    const filename = result.path ? result.path.split('/').pop() : '';
    return JSON.stringify({
      success: true,
      path: result.path,
      size: result.size,
      download: filename ? DOWNLOAD_BASE_URL + '/' + encodeURIComponent(filename) : '',
    });
  } catch (e) {
    log && log('warn', 'tool-exec/create_pdf error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}
