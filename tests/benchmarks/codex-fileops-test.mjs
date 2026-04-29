import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.lynn/server-info.json'), 'utf8'));
const base = `http://127.0.0.1:${info.port}`;
const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

function prepDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function runPrompt(prompt, cwd, label) {
  await api('POST', '/api/security-mode', { mode: 'authorized' });
  await api('POST', '/api/sessions/new', { cwd, memoryEnabled: false });
  const events = [];
  const tools = [];
  let text = '';
  let errors = [];
  let lastEventAt = Date.now();
  let turnEnds = 0;
  let statuses = [];
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, ['hana-cli', `token.${info.token}`]);
  const done = new Promise((resolve) => {
    const hard = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ timeout: true });
    }, 180000);
    const quietCheck = setInterval(() => {
      const quiet = Date.now() - lastEventAt;
      if (turnEnds > 0 && quiet > 8000) {
        clearTimeout(hard);
        clearInterval(quietCheck);
        try { ws.close(); } catch {}
        resolve({ timeout: false });
      }
    }, 1000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'prompt', text: prompt }));
    });
    ws.on('message', (raw) => {
      lastEventAt = Date.now();
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push(m.type);
      if (m.type === 'text_delta') text += m.delta || '';
      if (m.type === 'tool_start') tools.push({ event: 'start', name: m.name, args: m.args });
      if (m.type === 'tool_end') tools.push({ event: 'end', name: m.name, success: m.success, error: m.error });
      if (m.type === 'error') errors.push(m.message || JSON.stringify(m));
      if (m.type === 'turn_end') turnEnds++;
      if (m.type === 'status') statuses.push(m.isStreaming);
    });
    ws.on('error', (err) => errors.push(err.message));
  });
  const result = await done;
  return { label, result, events, tools, text, errors, turnEnds, statuses };
}

const baseTmp = '/tmp/lynn-realistic-fileops';
prepDir(baseTmp);

const createDir = path.join(baseTmp, 'create');
prepDir(createDir);
const r1 = await runPrompt('在当前目录新建一个 hello.txt 文件，内容写 hi。完成后读取这个文件确认内容。', createDir, 'create-file');
const helloPath = path.join(createDir, 'hello.txt');
const helloExists = fs.existsSync(helloPath);
const helloContent = helloExists ? fs.readFileSync(helloPath, 'utf8') : null;

const moveDir = path.join(baseTmp, 'move');
prepDir(moveDir);
fs.writeFileSync(path.join(moveDir, 'a.xlsx'), 'a');
fs.writeFileSync(path.join(moveDir, 'b.xls'), 'b');
fs.writeFileSync(path.join(moveDir, 'c.csv'), 'c');
fs.writeFileSync(path.join(moveDir, 'note.txt'), 'n');
const r2 = await runPrompt('把当前目录下所有 Excel 和 CSV 表格文件都移动到一个新建的“表格”文件夹里。完成后列出“表格”文件夹内容。', moveDir, 'move-spreadsheets');
const dest = path.join(moveDir, '表格');
const rootFiles = fs.readdirSync(moveDir).sort();
const destFiles = fs.existsSync(dest) ? fs.readdirSync(dest).sort() : [];

console.log(JSON.stringify({
  port: info.port,
  create: { exists: helloExists, content: helloContent, text: r1.text.slice(0, 1000), tools: r1.tools, errors: r1.errors, turnEnds: r1.turnEnds, timeout: r1.result.timeout },
  move: { rootFiles, destFiles, text: r2.text.slice(0, 1400), tools: r2.tools, errors: r2.errors, turnEnds: r2.turnEnds, timeout: r2.result.timeout },
}, null, 2));
