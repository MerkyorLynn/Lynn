// Brain v2 · tool-exec/create_artifact
// 接收 type/title/content,html 类型保存到 brain v1 的 public/downloads(共享)
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const PUBLIC_DOWNLOADS = process.env.LOBSTER_PUBLIC_DOWNLOADS || '/opt/lobster-brain/public/downloads';
const DOWNLOAD_BASE_URL = process.env.LOBSTER_DOWNLOAD_BASE_URL || 'https://download.merkyorlynn.com/downloads';

let _counter = 0;

export async function createArtifact(args, { log } = {}) {
  const a = args || {};
  const id = 'brain-art-' + Date.now() + '-' + (++_counter);
  const type = a.type || 'html';
  const title = String(a.title || 'Artifact');
  const content = String(a.content || '');
  log && log('info', 'tool-exec/create_artifact ' + type + ' / ' + title);

  if (type === 'html' && content.length > 100) {
    try {
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
      const filename = safeTitle + '-' + Date.now() + '.html';
      await fsp.mkdir(PUBLIC_DOWNLOADS, { recursive: true });
      await fsp.writeFile(path.join(PUBLIC_DOWNLOADS, filename), content, 'utf-8');
      const downloadUrl = DOWNLOAD_BASE_URL + '/' + encodeURIComponent(filename);
      return JSON.stringify({
        artifact_id: id, type, title,
        content_length: content.length,
        download_url: downloadUrl,
        message: '已创建 ' + type.toUpperCase() + ' 内容「' + title + '」,在线查看: ' + downloadUrl,
      });
    } catch (e) {
      log && log('warn', 'tool-exec/create_artifact save error: ' + e.message);
    }
  }
  return JSON.stringify({
    artifact_id: id, type, title,
    content_length: content.length,
    message: '已创建 ' + type.toUpperCase() + ' 内容「' + title + '」',
  });
}
