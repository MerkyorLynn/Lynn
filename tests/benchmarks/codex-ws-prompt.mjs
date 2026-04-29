import fs from 'fs';
import WebSocket from 'ws';

const info = JSON.parse(fs.readFileSync(`${process.env.HOME}/.lynn/server-info.json`, 'utf8'));
const prompt = process.argv.slice(2).join(' ');
if (!prompt) throw new Error('missing prompt');
const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, ['hana-cli', `token.${info.token}`]);
let text = '';
let tools = [];
let errors = [];
let done = false;
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ ok:false, timeout:true, prompt, tools, errors, text }, null, 2));
  try { ws.close(); } catch {}
  process.exit(124);
}, 120000);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'prompt', text: prompt }));
});
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'text_delta') text += msg.delta || '';
  if (msg.type === 'tool_start') tools.push({ event:'start', name: msg.name, args: msg.args });
  if (msg.type === 'tool_end') tools.push({ event:'end', name: msg.name, success: msg.success, error: msg.error });
  if (msg.type === 'error') errors.push(msg.message || JSON.stringify(msg));
  if (msg.type === 'turn_end') {
    done = true;
    clearTimeout(timeout);
    console.log(JSON.stringify({ ok:true, prompt, tools, errors, text }, null, 2));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (err) => {
  errors.push(err.message);
});
ws.on('close', () => {
  if (!done) {
    clearTimeout(timeout);
    console.log(JSON.stringify({ ok:false, closed:true, prompt, tools, errors, text }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
});
