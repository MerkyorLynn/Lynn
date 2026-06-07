import { spawn, execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const DEFAULT_PROVIDER_CONFIG = path.join(HOME, '.lynn-engine', 'providers', 'qwen35-9b-q4km-imatrix-gguf.json');
const DEFAULT_PID_FILE = path.join(HOME, '.lynn-engine', 'run', 'qwen35-9b-q4km-imatrix.pid');
const DEFAULT_LOG_FILE = path.join(HOME, '.lynn-engine', 'logs', 'qwen35-9b-q4km-imatrix.client.log');
const DEFAULT_MODEL_ROOT = path.join(HOME, 'Models', 'Lynn', 'Qwen3.5-9B');
const DEFAULT_HOST = process.env.LYNN_LOCAL_QWEN35_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.LYNN_LOCAL_QWEN35_PORT || 18099);
export const LOCAL_QWEN35_FALLBACK_PROVIDER = process.env.LYNN_LOCAL_QWEN35_FAILURE_FALLBACK_PROVIDER || 'step-3.7-flash';
export const LOCAL_QWEN35_RUNTIME_POLICY = Object.freeze({
  role: 'explicit_opt_in_local_9b',
  kv_cache_reuse: true,
  warm_pool_default: false,
  idle_unload: true,
  stable_prefix: true,
  small_context: true,
  max_history_messages: Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_MESSAGES || 8),
  max_history_chars: Number(process.env.LYNN_LOCAL_QWEN35_HISTORY_MAX_CHARS || 8000),
  tool_schema_limit: Math.max(3, Math.min(5, Number(process.env.LYNN_LOCAL_QWEN35_TOOL_SCHEMA_LIMIT || 5))),
  footer_decode_tps: true,
  failure_fallback_provider: LOCAL_QWEN35_FALLBACK_PROVIDER,
});

type LocalQwen35Options = {
  host?: string;
  port?: string | number;
  variant?: string;
};

type LocalQwen35SetupOptions = LocalQwen35Options & {
  authorized?: boolean;
  start?: boolean;
  installRuntime?: boolean;
};

type FileDescription = {
  path: string;
  exists: boolean;
  size_bytes?: number;
  mtime_ms?: number;
};

type LocalQwen35Job = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  started_at: string;
  finished_at: string | null;
  bootstrap: string;
  log_file: string;
  command: string[];
  exit_code: number | null;
  result: unknown;
  stdout_tail?: string;
  stderr_tail?: string;
  provider_config?: FileDescription;
};

type ExecFileError = Error & { stdout?: unknown; stderr?: unknown };

let currentJob: LocalQwen35Job | null = null;
let lastJob: LocalQwen35Job | null = null;

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function candidateBootstrapPaths() {
  if (process.env.LYNN_QWEN35_BOOTSTRAP) return [process.env.LYNN_QWEN35_BOOTSTRAP];
  const root = repoRoot();
  return [
    path.join(root, 'worktrees', 'codex-qwen35-9b-r6000-release', 'scripts', 'local_qwen35_9b_client_bootstrap.py'),
    path.join(root, 'lynn-engine', 'scripts', 'local_qwen35_9b_client_bootstrap.py'),
    path.join(root, 'lynn-engine-main', 'scripts', 'local_qwen35_9b_client_bootstrap.py'),
  ];
}

export function resolveBootstrapPath() {
  return candidateBootstrapPaths().find((p) => existsSync(p)) || null;
}

export function isLocalAddress(addr = '') {
  const v = String(addr || '').replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v === 'localhost' || v === '';
}

function commonArgs({ host = DEFAULT_HOST, port = DEFAULT_PORT, variant = 'imatrix' }: LocalQwen35Options = {}): string[] {
  return [
    '--variant', variant,
    '--host', String(host),
    '--port', String(port),
    '--model-root', process.env.LYNN_LOCAL_QWEN35_MODEL_ROOT || DEFAULT_MODEL_ROOT,
    '--provider-config', process.env.LYNN_LOCAL_QWEN35_PROVIDER_CONFIG || DEFAULT_PROVIDER_CONFIG,
    '--pid-file', process.env.LYNN_LOCAL_QWEN35_PID_FILE || DEFAULT_PID_FILE,
    '--log-file', process.env.LYNN_LOCAL_QWEN35_LOG_FILE || DEFAULT_LOG_FILE,
  ];
}

function readJsonMaybe(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

function describeFile(filePath: string): FileDescription {
  try {
    const st = statSync(filePath);
    return { path: filePath, exists: true, size_bytes: st.size, mtime_ms: st.mtimeMs };
  } catch {
    return { path: filePath, exists: false };
  }
}

export async function getLocalQwen35Plan(options: LocalQwen35Options = {}) {
  const bootstrap = resolveBootstrapPath();
  if (!bootstrap) {
    return {
      schema_version: 'lynn-local-qwen35-status-v1',
      ok: false,
      error: 'bootstrap_not_found',
      searched: candidateBootstrapPaths(),
      fallback_provider: LOCAL_QWEN35_FALLBACK_PROVIDER,
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  }
  try {
    const { stdout } = await execFileAsync('python3', [bootstrap, 'plan', ...commonArgs(options)], {
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      bootstrap,
      plan: readJsonMaybe(stdout),
      job: currentJob || lastJob,
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  } catch (err) {
    const e = err as ExecFileError;
    return {
      ok: false,
      bootstrap,
      error: e.message,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      job: currentJob || lastJob,
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  }
}

export function startLocalQwen35Setup({
  authorized = false,
  start = true,
  installRuntime = true,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  variant = 'imatrix',
}: LocalQwen35SetupOptions = {}) {
  if (!authorized) {
    return {
      ok: false,
      error: 'missing_user_authorization',
      message: 'Client must pass authorized:true after the user approves local setup.',
      runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY,
    };
  }
  if (currentJob?.status === 'running') return { ok: true, job: currentJob, already_running: true, runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY };
  const bootstrap = resolveBootstrapPath();
  if (!bootstrap) return { ok: false, error: 'bootstrap_not_found', searched: candidateBootstrapPaths(), runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY };

  const logFile = process.env.LYNN_LOCAL_QWEN35_SETUP_LOG || path.join(HOME, '.lynn-engine', 'logs', `qwen35-9b-mtp-setup-${Date.now()}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  const args = [
    bootstrap,
    'execute',
    ...commonArgs({ host, port, variant }),
    '--yes-user-authorized',
  ];
  if (start) args.push('--start');
  if (!installRuntime) args.push('--no-install-runtime');

  const startedAt = new Date().toISOString();
  currentJob = {
    id: 'local-qwen35-setup-' + Date.now(),
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    bootstrap,
    log_file: logFile,
    command: ['python3', ...args],
    exit_code: null,
    result: null,
  };

  const child = spawn('python3', args, {
    cwd: repoRoot(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  const append = (chunk: string) => {
    try {
      appendFileSync(logFile, chunk);
    } catch {}
  };
  child.stdout.on('data', (buf) => { const s = buf.toString(); stdout += s; append(s); });
  child.stderr.on('data', (buf) => { const s = buf.toString(); stderr += s; append(s); });
  child.on('exit', (code) => {
    const result = readJsonMaybe(stdout);
    currentJob = {
      ...(currentJob as LocalQwen35Job),
      status: code === 0 ? 'succeeded' : 'failed',
      finished_at: new Date().toISOString(),
      exit_code: code,
      result,
      stdout_tail: stdout.slice(-4000),
      stderr_tail: stderr.slice(-4000),
      provider_config: describeFile(process.env.LYNN_LOCAL_QWEN35_PROVIDER_CONFIG || DEFAULT_PROVIDER_CONFIG),
    };
    lastJob = currentJob;
  });

  return { ok: true, job: currentJob, runtime_policy: LOCAL_QWEN35_RUNTIME_POLICY };
}

export function getLocalQwen35Job() {
  return currentJob || lastJob;
}
