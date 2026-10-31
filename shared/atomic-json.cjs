const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Apply only edits made to the caller's snapshot, preserving another writer's fields.
function mergeJsonChanges(latest, before, after) {
  if (!record(before) || !record(after)) return structuredClone(after);
  const next = record(latest) ? structuredClone(latest) : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (equal(before[key], after[key]) && Object.hasOwn(before, key) === Object.hasOwn(after, key)) continue;
    if (!Object.hasOwn(after, key)) delete next[key];
    else next[key] = mergeJsonChanges(next[key], before[key], after[key]);
  }
  return next;
}

function updateJsonFileSync(filePath, update, io = fs) {
  io.mkdirSync(path.dirname(filePath), { recursive: true });
  const lock = `${filePath}.lock`;
  const started = Date.now();
  let lockFd;
  while (lockFd === undefined) {
    try {
      lockFd = io.openSync(lock, 'wx', 0o600);
      io.writeFileSync(lockFd, String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(io.readFileSync(lock, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probe) { if (probe.code === 'ESRCH') { io.unlinkSync(lock); continue; } }
        }
      } catch {}
      if (Date.now() - started > 1500) throw new Error('Settings are being saved by another process; please retry.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    let current = {};
    try { current = JSON.parse(io.readFileSync(filePath, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) {
        const backup = `${filePath}.invalid.${randomUUID()}`;
        io.renameSync(filePath, backup);
        io.chmodSync(backup, 0o600);
      } else if (error.code !== 'ENOENT') throw error;
    }
    const next = update(current);
    io.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    io.renameSync(tmp, filePath);
    return next;
  } finally {
    try { io.unlinkSync(tmp); } catch {}
    io.closeSync(lockFd);
    io.unlinkSync(lock);
  }
}
module.exports = { mergeJsonChanges, updateJsonFileSync };
