/**
 * sandboxLocal.ts
 * ---------------
 * Docker-free local re-implementation of the node-code-sandbox-mcp execution
 * tools. The upstream repository is fundamentally built on `docker run/exec/
 * cp/rm`; because the target environment must run WITHOUT Docker, we cannot
 * call those upstream tool functions directly. Instead we REIMPLEMENT their
 * behaviour on the host, while REUSING upstream's docker-free pure helpers:
 *
 *   - types.textContent            (result shaping)
 *   - utils.preprocessDependencies / sanitizeContainerId / sanitizeShellCommand
 *                                   / DEFAULT_NODE_IMAGE / generateSuggestedImages
 *   - runUtils.prepareWorkspace    (writes index.js + package.json to a temp dir)
 *   - snapshotUtils.getSnapshot / detectChanges  (file-change detection)
 *
 * The session registry (session id -> workspace directory) replaces Docker's
 * container lifecycle so the same tool contract is preserved:
 *
 *   sandbox_initialize -> sandbox_exec -> run_js -> sandbox_stop
 *
 * `run_js_ephemeral` runs in a throwaway temp dir and auto-cleans.
 */

import { z } from 'zod';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import mime from 'mime-types';
import tmp from 'tmp';

import {
  textContent,
  type McpResponse,
  type McpContent,
} from '../node-code-sandbox-mcp/dist/types.js';
import {
  preprocessDependencies,
  sanitizeContainerId,
  sanitizeShellCommand,
  DEFAULT_NODE_IMAGE,
  generateSuggestedImages,
} from '../node-code-sandbox-mcp/dist/utils.js';
import { prepareWorkspace } from '../node-code-sandbox-mcp/dist/runUtils.js';
import {
  getSnapshot,
  detectChanges,
} from '../node-code-sandbox-mcp/dist/snapshotUtils.js';

// `Change` and `FileSnapshot` are not re-exported by upstream; derive them from
// the exported function signatures so we stay in lock-step with upstream.
type UpFileSnapshot = Awaited<ReturnType<typeof getSnapshot>>;
type UpChange = Awaited<ReturnType<typeof detectChanges>> extends Array<infer C>
  ? C
  : never;

/** Convert any McpResponse into a single human-readable text blob. */
export function responseToText(resp: McpResponse): string {
  const parts: string[] = [];
  for (const c of resp.content) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image')
      parts.push(`[image:${c.mimeType} ${c.data.length} base64 bytes]`);
    else if (c.type === 'resource') {
      const r = c.resource as unknown as {
        text?: string;
        blob?: string;
        uri: string;
      };
      const label =
        typeof r.text === 'string'
          ? r.text
          : typeof r.blob === 'string'
            ? '[binary blob]'
            : r.uri;
      parts.push(`[file:${label} -> ${r.uri}]`);
    }
  }
  const joined = parts.join('\n');
  return resp.isError ? `Error: ${joined}` : joined;
}

// ---------------------------------------------------------------------------
// Session registry (replaces Docker containers)
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  workspaceDir: string;
  pid?: number; // background process pid (detached mode)
}

const sessions = new Map<string, Session>();

function expandPath(p: string): string {
  if (!p) return os.homedir();
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export function resolveWorkspacePath(raw: string | undefined): string {
  return expandPath(raw && raw.trim() ? raw : '~/.nodejs-mcp');
}

function sessionsRoot(workspacePath: string): string {
  return path.join(workspacePath, 'sessions');
}

function newSessionId(): string {
  // SanitizeContainerId allows [a-zA-Z0-9][a-zA-Z0-9_.-]* ; uuid has dashes.
  let id = `js-sbx-${randomUUID().replace(/-/g, '')}`;
  if (!sanitizeContainerId(id)) id = `sbx-${randomUUID()}`;
  return id;
}

// ---------------------------------------------------------------------------
// Configuration passed from the toolsProvider (always present)
// ---------------------------------------------------------------------------

export interface EngineContext {
  workspacePath: string; // resolved absolute path from the Plugin UI setting
}

// ---------------------------------------------------------------------------
// Argument schemas (copied from upstream tool files — pure zod, no Docker)
// ---------------------------------------------------------------------------

const NodeDependency = z.object({
  name: z.string().describe('npm package name, e.g. lodash'),
  version: z
    .string()
    .describe('npm package version range, e.g. ^4.17.21'),
});

export const initializeSchema = {
  image: z
    .string()
    .optional()
    .describe(`Docker image (ignored without Docker; kept for parity). Suggested:\n${generateSuggestedImages()}`),
  port: z.number().optional().describe('Port to expose (ignored without Docker)'),
};

export const execSchema = {
  container_id: z.string().describe('Sandbox session id from sandbox_initialize'),
  commands: z.array(z.string().min(1)).describe('Shell commands to run in the session.'),
};

export const runJsSchema = {
  container_id: z.string().describe('Sandbox session id from sandbox_initialize'),
  dependencies: z
    .array(NodeDependency)
    .default([])
    .describe('npm dependencies to install before running the code.'),
  code: z.string().describe('JavaScript (ESModule) source to run inside the sandbox.'),
  listenOnPort: z
    .number()
    .optional()
    .describe('If set, leave the process running in background and expose this port.'),
};

export const stopSchema = {
  container_id: z
    .string()
    .describe('Sandbox session id from sandbox_initialize'),
};

export const ephemeralSchema = {
  image: z
    .string()
    .optional()
    .default(DEFAULT_NODE_IMAGE)
    .describe(`Image (ignored without Docker). Suggested:\n${generateSuggestedImages()}`),
  dependencies: z
    .array(NodeDependency)
    .default([])
    .describe('npm dependencies to install before running the code.'),
  code: z.string().describe('JavaScript (ESModule) source to run in a disposable sandbox.'),
};

export const searchNpmSchema = {
  searchTerm: z
    .string()
    .min(1, 'Search term cannot be empty.')
    .regex(/^\S+$/, 'Search term cannot contain spaces.')
    .describe(
      'Term to search for in npm packages. Use + to combine terms (e.g. "react+components").'
    ),
  qualifiers: z
    .object({
      author: z.string().optional(),
      maintainer: z.string().optional(),
      scope: z.string().optional(),
      keywords: z.string().optional(),
      not: z.string().optional(),
      is: z.string().optional(),
      boostExact: z.string().optional(),
    })
    .optional()
    .describe('Optional qualifiers to filter search results.'),
};

export const readTextFileSchema = {
  path: z
    .string()
    .min(1, 'Path cannot be empty.')
    .describe('Path to a file or directory, relative to the workspace root.'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('For a text file, stop reading after this many bytes. Omit to read the whole file.'),
};

// ---------------------------------------------------------------------------
// Small exec helpers (host-side, no Docker)
// ---------------------------------------------------------------------------

function npmInstall(workspaceDir: string, timeoutMs: number): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--loglevel=error'],
      { cwd: workspaceDir, encoding: 'utf8', timeout: timeoutMs }
    );
    return { ok: true, output: String(output || '') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: message };
  }
}

function nodeRun(workspaceDir: string, timeoutMs: number): {
  output: string;
  error: string | null;
  durationMs: number;
} {
  const start = Date.now();
  try {
    const output = execFileSync('node', ['index.js'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { output: String(output), error: null, durationMs: Date.now() - start };
  } catch (err) {
    const e = err as { status?: number; signal?: string; stderr?: string; message?: string };
    const stderr = String(e?.stderr ?? e?.message ?? err);
    return { output: '', error: stderr.trim(), durationMs: Date.now() - start };
  }
}

async function waitForPortHttp(port: number, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.ok || res.status === 404) return true;
    } catch {
      // not ready yet
    }
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// File-change handling
// ---------------------------------------------------------------------------

const EXCLUDED_OUTPUT_NAMES = new Set([
  'index.js',
  'package.json',
  'package-lock.json',
]);

function excluded(name: string): boolean {
  return EXCLUDED_OUTPUT_NAMES.has(name);
}

async function attachFileContent(absPath: string): Promise<McpContent[]> {
  if (excluded(path.basename(absPath))) return [];
  const contents: McpContent[] = [];
  const mimeType = ((mime.lookup(absPath) as string) ||
    'application/octet-stream') as string;

  contents.push(
    textContent(`I saved the file ${path.basename(absPath)} at ${absPath}`)
  );

  if (/^image\/(png|jpeg|jpe|jpg)$/.test(mimeType)) {
    try {
      const b64 = await fsp.readFile(absPath, { encoding: 'base64' });
      contents.push({ type: 'image', data: b64, mimeType });
    } catch {
      // ignore read errors
    }
  }

  contents.push({
    type: 'resource',
    resource: { uri: pathToFileURL(absPath).href, mimeType, text: path.basename(absPath) },
  });
  return contents;
}

async function assembleChanges(
  changes: UpChange[],
  copyFromDir: string,
  hostBaseDir: string | null
): Promise<McpContent[]> {
  const contents: McpContent[] = [];
  const summary: string[] = [];

  for (const change of changes) {
    if (change.type === 'deleted') continue;

    const fname = path.basename(change.path);
    if (excluded(fname)) continue;
    summary.push(`- ${fname} was ${change.type}`);

    let hostPath = change.path;
    // For ephemeral sandboxes the files live in a temp dir that will be removed.
    // Copy them into the persistent workspace so the user can retrieve them.
    if (hostBaseDir && copyFromDir !== hostBaseDir.split(path.sep).slice(0, -1).join(path.sep)) {
      try {
        await fsp.mkdir(hostBaseDir, { recursive: true });
        await fsp.copyFile(change.path, path.join(hostBaseDir, fname));
        hostPath = path.join(hostBaseDir, fname);
      } catch {
        hostPath = change.path;
      }
    }

    contents.push(...(await attachFileContent(hostPath)));
  }

  if (summary.length > 0) {
    contents.push(textContent(`List of changed files:\n${summary.join('\n')}`));
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Lightweight filesystem inspection (list directory / read text file)
// ---------------------------------------------------------------------------

/** Resolve `rel` against the workspace root, rejecting escapes outside it. */
function safeResolve(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

async function listDirectoryLocal(dirAbs: string): Promise<McpResponse> {
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [textContent(`Error listing directory: ${message}`)], isError: true };
  }

  const dirs: string[] = [];
  const files: string[] = [];
  const others: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
    else others.push(`${e.name} (symlink/socket/etc.)`);
  }
  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));

  const lines: string[] = [`Directory: ${dirAbs}`];
  if (dirs.length) {
    lines.push(`\nDirectories (${dirs.length}):`);
    lines.push(...dirs.map((d) => `  ${d}/`));
  }
  if (files.length) {
    lines.push(`\nFiles (${files.length}):`);
    lines.push(...files.map((f) => `  ${f}`));
  }
  if (others.length) {
    lines.push(`\nOthers (${others.length}):`);
    lines.push(...others.map((o) => `  ${o}`));
  }

  return { content: [textContent(lines.join('\n'))] };
}

async function readFileTextLocal(
  abs: string,
  size: number,
  maxBytes?: number,
): Promise<McpResponse> {
  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : size;

  let text: string;
  try {
    text = await fsp.readFile(abs, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [textContent(`Error reading file: ${message}`)], isError: true };
  }

  const truncated = size > limit;
  const header = `File: ${abs}\nSize: ${size} bytes\n`;
  const body = truncated
    ? `${text.slice(0, limit)}\n... [truncated: showing ${limit} of ${size} bytes] ...`
    : text;

  return { content: [textContent(header + body)] };
}

/**
 * Lightweight file/directory inspector.
 *
 * Resolves `path` against the workspace root (traversal outside the workspace is
 * rejected) and then either lists the directory or reads the file as UTF-8 text.
 * This lets an LLM inspect artifacts saved by run_js / run_js_ephemeral without
 * dropping to raw shell commands.
 */
export async function readTextFileLocal(
  params: { path: string; maxBytes?: number },
  ctx: EngineContext,
): Promise<McpResponse> {
  const abs = safeResolve(ctx.workspacePath, params.path);
  if (!abs) {
    return {
      content: [textContent(`Error: "${params.path}" escapes the workspace directory.`)],
      isError: true,
    };
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { content: [textContent(`Error: "${params.path}" does not exist in the workspace.`)], isError: true };
  }

  if (stat.isDirectory()) return listDirectoryLocal(abs);
  return readFileTextLocal(abs, stat.size, params.maxBytes);
}

// ---------------------------------------------------------------------------
// Tool implementations (Docker-free)
// ---------------------------------------------------------------------------

export async function initializeLocal(
  params: { image?: string; port?: number },
  ctx: EngineContext
): Promise<McpResponse> {
  const id = newSessionId();
  const workspaceDir = path.join(sessionsRoot(ctx.workspacePath), id);
  try {
    await fsp.mkdir(workspaceDir, { recursive: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [textContent(`Failed to create sandbox workspace: ${message}`)], isError: true };
  }
  sessions.set(id, { id, workspaceDir });
  return { content: [textContent(id)] };
}

export async function execLocal(
  params: { container_id: string; commands: string[] },
  ctx: EngineContext
): Promise<McpResponse> {
  const validId = sanitizeContainerId(params.container_id);
  if (!validId) return { content: [textContent('Invalid container ID')], isError: true };

  const session = sessions.get(validId);
  if (!session) {
    return {
      content: [textContent(`No running sandbox with ID "${validId}". Run sandbox_initialize first.`)],
      isError: true,
    };
  }

  const outputs: string[] = [];
  for (const command of params.commands) {
    const sanitized = sanitizeShellCommand(command);
    if (!sanitized) {
      return { content: [textContent('Command rejected: contains dangerous metacharacters.')], isError: true };
    }
    try {
      const out = execFileSync('/bin/sh', ['-c', sanitized], {
        cwd: session.workspaceDir,
        encoding: 'utf8',
      });
      outputs.push(String(out));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [textContent(`Command failed: ${message}`)], isError: true };
    }
  }
  return { content: [textContent(outputs.join('\n'))] };
}

export async function runJsLocal(
  params: {
    container_id: string;
    code: string;
    dependencies?: Array<{ name: string; version: string }>;
    listenOnPort?: number;
  },
  ctx: EngineContext
): Promise<McpResponse> {
  const validId = sanitizeContainerId(params.container_id);
  const session = validId ? sessions.get(validId) : undefined;
  if (!session) {
    return {
      content: [textContent(`No running sandbox with ID "${params.container_id}". Run sandbox_initialize first.`)],
      isError: true,
    };
  }

  const workspaceDir = session.workspaceDir;
  const depsRecord = preprocessDependencies({
    dependencies: params.dependencies ?? [],
  });

  // Write the script + package.json directly into the persistent session dir.
  await fsp.writeFile(path.join(workspaceDir, 'index.js'), params.code, 'utf8');
  await fsp.writeFile(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: depsRecord }, null, 2),
    'utf8'
  );

  const telemetry: Record<string, unknown> = {};
  let rawOutput = '';
  let error: string | null = null;

  if (params.dependencies && params.dependencies.length > 0) {
    const t0 = Date.now();
    const install = npmInstall(workspaceDir, 120_000);
    telemetry.installTimeMs = Date.now() - t0;
    telemetry.installOutput = install.output || 'Skipped npm install (no dependencies)';
  }

  // Snapshot taken just before execution so that files created or modified by
  // the script are detected afterwards. index.js, package.json and
  // package-lock.json are excluded from surfacing (see EXCLUDED_OUTPUT_NAMES).
  const snapshotStartTime = Date.now();
  const before = await getSnapshot(workspaceDir);

  if (params.listenOnPort) {
    // Detached mode: start node in the background, expose the port to the host.
    const logPath = path.join(workspaceDir, 'output.log');
    const logStream = fs.createWriteStream(logPath);
    const child = spawn('node', ['index.js'], {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    child.on('close', () => logStream.end());
    session.pid = child.pid;
    const ready = await waitForPortHttp(params.listenOnPort);
    telemetry.runTimeMs = 0;
    if (!ready) {
      return {
        content: [textContent(`Server started in background (pid ${session.pid}) but did not respond on the port.`)],
        isError: true,
      };
    }
    rawOutput = `Server started in background (pid ${session.pid}); logs at ${logPath}`;
  } else {
    const run = nodeRun(workspaceDir, 30_000);
    rawOutput = run.output;
    error = run.error;
    telemetry.runTimeMs = run.durationMs;
  }

  // Detect files created/modified during execution and surface them.
  await new Promise((r) => setTimeout(r, 50));
  const changes = await detectChanges(before, workspaceDir, snapshotStartTime);
  const extracted = await assembleChanges(changes, workspaceDir, null);

  if (error) {
    return {
      content: [
        textContent(`Error during execution: ${error}`),
        textContent(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`),
      ],
      isError: true,
    };
  }

  return {
    content: [
      textContent(`Node.js process output:\n${rawOutput}`),
      ...extracted,
      textContent(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`),
    ],
  };
}

export async function stopLocal(
  params: { container_id: string },
  ctx: EngineContext
): Promise<McpResponse> {
  const validId = sanitizeContainerId(params.container_id);
  if (!validId) return { content: [textContent('Invalid container ID')], isError: true };

  const session = sessions.get(validId);
  try {
    if (session?.pid != null) {
      try {
        process.kill(-session.pid, 'SIGKILL'); // kill process group
      } catch {
        try {
          process.kill(session.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // ignore
  }

  sessions.delete(validId);
  try {
    await fsp.rm(path.join(sessionsRoot(ctx.workspacePath), validId), {
      recursive: true,
      force: true,
    });
  } catch {
    // best-effort cleanup
  }
  return { content: [textContent(`Container ${params.container_id} removed.`)] };
}

export async function runJsEphemeralLocal(
  params: {
    image?: string;
    code: string;
    dependencies?: Array<{ name: string; version: string }>;
  },
  ctx: EngineContext
): Promise<McpResponse> {
  const tmpDir = tmp.dirSync({ unsafeCleanup: true }).name;
  const depsRecord = preprocessDependencies({
    dependencies: params.dependencies ?? [],
  });

  // Reuse upstream's docker-free workspace preparer (writes index.js + package.json).
  const ws = await prepareWorkspace({ code: params.code, dependenciesRecord: depsRecord });

  const telemetry: Record<string, unknown> = {};
  let rawOutput = '';
  let error: string | null = null;

  if (params.dependencies && params.dependencies.length > 0) {
    const t0 = Date.now();
    const install = npmInstall(ws.name, 120_000);
    telemetry.installTimeMs = Date.now() - t0;
    telemetry.installOutput = install.output || 'Skipped npm install (no dependencies)';
  }

  // Snapshot taken just before execution so that files created or modified by
  // the script are detected afterwards. index.js, package.json and
  // package-lock.json are excluded from surfacing (see EXCLUDED_OUTPUT_NAMES).
  const snapshotStartTime = Date.now();
  const before = await getSnapshot(ws.name);

  {
    const run = nodeRun(ws.name, 30_000);
    rawOutput = run.output;
    error = run.error;
    telemetry.runTimeMs = run.durationMs;
  }

  // Copy any saved files into the persistent workspace so they survive cleanup.
  await new Promise((r) => setTimeout(r, 50));
  const changes = await detectChanges(before, ws.name, snapshotStartTime);

  let extracted: McpContent[] = [];
  if (!error) {
    extracted = await assembleChanges(changes, ws.name, ctx.workspacePath);
  }

  ws.removeCallback();

  if (error) {
    return {
      content: [
        textContent(`Error during execution: ${error}`),
        textContent(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`),
      ],
      isError: true,
    };
  }

  return {
    content: [
      textContent(`Node.js process output:\n${rawOutput}`),
      ...extracted,
      textContent(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`),
    ],
  };
}
