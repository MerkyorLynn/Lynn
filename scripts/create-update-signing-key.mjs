import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privatePath = process.env.LYNN_UPDATE_SIGNING_KEY_PATH || path.join(os.homedir(), '.config', 'lynn-release', 'update-signing-ed25519.pem');
fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
if (!fs.existsSync(privatePath)) {
  const { privateKey } = generateKeyPairSync('ed25519');
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
}
fs.chmodSync(privatePath, 0o600);
const privateKey = createPrivateKey(fs.readFileSync(privatePath));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 release identity');
const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const publicFile = path.join(root, 'shared', 'update-signing-public.cjs');
const content = `// Public verification identity; private material is never shipped.\nmodule.exports = ${JSON.stringify({ keyId, publicKey }, null, 2)};\n`;
if (fs.existsSync(publicFile) && fs.readFileSync(publicFile, 'utf8') !== content) throw new Error('Public identity differs; explicit rotation is required');
if (!fs.existsSync(publicFile)) fs.writeFileSync(publicFile, content);
console.log('Release signing identity ready');
