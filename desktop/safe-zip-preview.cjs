const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function extractSkillPreview(archive, tempRoot) {
  if (fs.statSync(archive).size > 20 * 1024 * 1024) throw new Error('Skill archive exceeds 20 MB.');
  const zip = await require('jszip').loadAsync(fs.readFileSync(archive));
  const entries = Object.values(zip.files);
  if (entries.length > 1000) throw new Error('Skill archive contains too many entries.');
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    const kind = Number(entry.unixPermissions || 0) & 0o170000;
    if (!name || /[\\\0]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name)
      || name.split('/').includes('..') || (kind && kind !== 0o100000 && kind !== 0o040000)) {
      throw new Error('Skill archive contains an unsafe path or special file.');
    }
  }
  const root = fs.mkdtempSync(path.join(tempRoot, 'lynn-skill-preview-'));
  let total = 0;
  try {
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      const rel = path.relative(root, target);
      if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error('Unsafe archive path.');
      if (entry.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let size = 0;
      const limit = new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length; total += chunk.length;
        if (size > 32 * 1024 * 1024 || total > 100 * 1024 * 1024) callback(new Error('Expanded skill archive exceeds its size limit.'));
        else callback(null, chunk);
      } });
      await pipeline(entry.nodeStream(), limit, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    }
    return root;
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
module.exports = { extractSkillPreview };
