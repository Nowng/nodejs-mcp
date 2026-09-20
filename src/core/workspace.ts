/**
 * Execution backend for the LM Studio plugin.
 *
 * The original node-code-sandbox-mcp ran every tool inside a disposable
 * Docker container. LM Studio's plugin runtime has no Docker, so each
 * "sandbox" is now just a local workspace directory and each script is
 * executed by spawning the same Node.js that runs this plugin
 * (`process.execPath`) as its own process. This keeps real isolation,
 * native ESModule (`import`/`export`) support and stdout/stderr capture.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface Workspace {
  id: string;
  dir: string;
  filesDir: string;
  createdAt: number;
  pids: Set<number>;
}

const workspaces = new Map<string, Workspace>();

export function getWorkspace(id: string): Workspace | undefined {
  return workspaces.get(id);
}

export function listWorkspaces(): Workspace[] {
  return [...workspaces.values()];
}

/**
 * Docker container names/IDs must match [a-zA-Z0-9][a-zA-Z0-9_.-]*.
 * Reuse the same rule for workspace ids.
 */
export function sanitizeWorkspaceId(id: string): string | null {
  if (typeof id !== 'string') return null;
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) return id;
  return null;
}

/** Basic shell-command sanitizer: block command substitution (` and $()). */
export function sanitizeShellCommand(cmd: string): string | null {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (/[`]|\\$\\([^)]+\\)/.test(cmd)) return null;
  return cmd;
}

const ROOT = path.join(os.tmpdir(), 'lm-studio-node-sandbox');

export async function createWorkspace(
  outputSubdir = 'files'
): Promise<Workspace> {
  const id = `ws-${randomUUID()}`;
  const dir = path.join(ROOT, id);
  await fsp.mkdir(path.join(dir, outputSubdir), { recursive: true });
  const ws: Workspace = {
    id,
    dir,
    filesDir: path.join(dir, outputSubdir),
    createdAt: Date.now(),
    pids: new Set(),
  };
  workspaces.set(id, ws);
  return ws;
}

export async function removeWorkspace(ws: Workspace): Promise<void> {
  for (const pid of ws.pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  ws.pids.clear();
  try {
    await fsp.rm(ws.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  workspaces.delete(ws.id);
}

export async function cleanupAll(): Promise<void> {
  await Promise.all(listWorkspaces().map((ws) => removeWorkspace(ws)));
}

const EXCLUDE = new Set([
  'index.js',
  'package.json',
  'package-lock.json',
  'node_modules',
]);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

function lookupMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    xml: 'application/xml',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function writeScript(
  ws: Workspace,
  code: string,
  dependenciesRecord: Record<string, string> = {}
): Promise<void> {
  await fsp.writeFile(path.join(ws.dir, 'index.js'), code);
  await fsp.writeFile(
    path.join(ws.dir, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: dependenciesRecord }, null, 2)
  );
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function spawnWithTimeout(
  executable: string,
  args: string[],
  opts: SpawnOptions,
  { timeoutMs = 30_000, signal }: { timeoutMs?: number; signal?: AbortSignal }
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(executable, args, opts);
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, code: null, timedOut: true });
      }
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: null, timedOut: false });
      }
    };
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGKILL');
        resolve({ stdout, stderr, code: null, timedOut: false });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      stderr += `Failed to start ${executable}: ${err.message}\n`;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, code: null, timedOut: false });
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ stdout, stderr, code, timedOut: false });
      }
    });
  });
}

/** Run a JS file as an ES module in its own Node.js process. */
export async function runNodeScript(
  ws: Workspace,
  {
    entry = 'index.js',
    timeoutMs = 30_000,
    signal,
  }: { entry?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RunResult> {
  return spawnWithTimeout(
    process.execPath,
    [path.join(ws.dir, entry)],
    { cwd: ws.dir, env: { ...process.env } },
    { timeoutMs, signal }
  );
}

/** Run a shell command inside a workspace directory. */
export async function runShellCommand(
  ws: Workspace,
  command: string,
  {
    timeoutMs = 30_000,
    signal,
  }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RunResult> {
  return spawnWithTimeout(
    'sh',
    ['-c', command],
    { cwd: ws.dir, env: { ...process.env } },
    { timeoutMs, signal }
  );
}

export interface NpmInstallResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Run `npm install` inside a workspace. Best-effort: npm may be absent. */
export async function runNpmInstall(
  ws: Workspace,
  { signal }: { signal?: AbortSignal } = {}
): Promise<NpmInstallResult> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'],
      { cwd: ws.dir, env: { ...process.env } }
    );
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    child.on('error', () =>
      resolve({
        ok: false,
        output,
        error: 'npm is not available in this environment; skipping dependency install.',
      })
    );
    child.on('close', (code) =>
      resolve({ ok: code === 0, output })
    );
    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill('SIGKILL');
      }, { once: true });
    }
  });
}

/**
 * Start a script as a detached background server on `port`.
 * Best-effort parity with the original "detached mode". The spawned
 * process is unref'd so it can outlive the tool call; its pid is tracked
 * for cleanup. Note: an LLM cannot itself reach this localhost server.
 */
export async function startBackgroundServer(
  ws: Workspace,
  {
    port,
    timeoutMs = 10_000,
    intervalMs = 250,
    signal,
  }: {
    port: number;
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  }
): Promise<{ ok: boolean; message: string }> {
  const child = spawn(
    process.execPath,
    [path.join(ws.dir, 'index.js')],
    { cwd: ws.dir, env: { ...process.env }, detached: true }
  );
  ws.pids.add(child.pid ?? -1);
  try {
    child.unref();
  } catch {
    /* ignore */
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      return { ok: false, message: 'Aborted before the server became ready.' };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { signal });
      if (res.ok || res.status === 404) {
        return {
          ok: true,
          message: `Server started in background on port ${port}; logs at ${path.join(ws.dir, 'output.log')}.`,
        };
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ok: false,
    message: `Timeout: server did not respond on port ${port} within ${timeoutMs}ms.`,
  };
}

/** List files the script produced in the output folder and describe them. */
export async function extractOutputs(
  ws: Workspace,
  filesSubdir = 'files'
): Promise<string> {
  const base = path.join(ws.dir, filesSubdir);
  if (!fs.existsSync(base)) return '';

  const entries = await fsp.readdir(base, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || EXCLUDE.has(entry.name)) continue;
    const name = entry.name;
    const full = path.join(base, name);
    const isImage = IMAGE_EXT.has(name.split('.').pop()?.toLowerCase() ?? '');

    if (isImage) {
      const b64 = await fsp.readFile(full, { encoding: 'base64' });
      lines.push(
        `Saved image ${name} (${lookupMime(name)}) as base64: data/${lookupMime(
          name
        )};base64,${b64}`
      );
    } else {
      const text = await fsp.readFile(full, 'utf8');
      lines.push(`Saved file ${name}: ${truncate(text, 2000)}`);
    }
  }
  return lines.length ? 'Files produced by the script:\n' + lines.join('\n') : '';
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

// ---------------------------------------------------------------------------
// Text-IO helpers for the list_directory / read_text_file / write_text_file
// tools. Every path is resolved against a fixed base directory (each sandbox's
// output folder) and must stay inside it, so these cannot escape the sandbox.
// ---------------------------------------------------------------------------

/** Maximum characters returned by read_text_file. */
export const MAX_TEXT_LENGTH = 20000;

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve requestPath against baseDir and ensure the result stays inside it.
 * Returns the resolved absolute path, or null if it escapes (or is empty).
 */
export function resolveInside(baseDir: string, requestPath: string): string | null {
  if (typeof requestPath !== 'string' || !requestPath.trim()) return null;
  const resolved = path.resolve(baseDir, requestPath);
  const prefix = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (resolved === baseDir || resolved.startsWith(prefix)) return resolved;
  return null;
}

export async function listDirectoryContents(
  baseDir: string,
  requestPath?: string
): Promise<{ entries: string[]; error?: string }> {
  let isFile = false;
  let isDir = false;
  try {
    const st = await fsp.stat(baseDir);
    isDir = st.isDirectory();
  } catch (e) {
    return { entries: [], error: errMsg(e) };
  }

  if (!isDir) {
    // requestPath points at a single file
    let ok = false;
    try {
      const st = await fsp.stat(path.resolve(baseDir, requestPath ?? ''));
      ok = st.isFile();
    } catch {
      ok = false;
    }
    return ok ? { entries: [path.basename(path.resolve(baseDir, requestPath ?? ''))] } : { entries: [], error: 'Path does not exist.' };
  }

  const entries: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const all = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!all) return;
    for (const e of all) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        entries.push(`${relPath}/`);
        await walk(path.join(dir, e.name), relPath);
      } else {
        entries.push(relPath);
      }
    }
  }
  await walk(baseDir, '');
  return { entries: entries.sort() };
}

/**
 * Read a file as text. Returns ok=false with an error if the path is missing,
 * is not a file, or looks binary (contains null bytes). Otherwise returns the
 * utf8 text (truncated to MAX_TEXT_LENGTH).
 */
export async function readTextFileContents(
  resolvedPath: string,
  maxLength = MAX_TEXT_LENGTH
): Promise<{ ok: boolean; content?: string; error?: string }> {
  let buf: Buffer;
  try {
    const st = await fsp.stat(resolvedPath);
    if (!st.isFile()) return { ok: false, error: 'Not a file.' };
    buf = await fsp.readFile(resolvedPath);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  if (buf.indexOf(0) !== -1) {
    return {
      ok: false,
      error: 'This does not look like a text file (it appears to be binary). Use run_js to handle binary files.',
    };
  }
  const text = buf.toString('utf8');
  if (text.length > maxLength) {
    return {
      ok: true,
      content: `${text.slice(0, maxLength)}… [truncated ${text.length - maxLength} chars]`,
    };
  }
  return { ok: true, content: text };
}

/** Write a text file, creating parent directories as needed. */
export async function writeTextFileContents(
  resolvedPath: string,
  content: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fsp.writeFile(resolvedPath, content);
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
  return { ok: true };
}
