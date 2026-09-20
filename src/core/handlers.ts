/**
 * Core logic for every tool. These are plain async functions that take the
 * tool arguments plus a small execution context (`signal`/`status`/`warn`/
 * `config`) and return a single string. They contain no @lmstudio/sdk
 * imports, so the same handlers could be re-exposed as an MCP server later.
 */
import { z } from 'zod';
import type { ChatConfig } from '../config.ts';
import {
  createWorkspace,
  getWorkspace,
  removeWorkspace,
  sanitizeShellCommand,
  sanitizeWorkspaceId,
  writeScript,
  runNpmInstall,
  runNodeScript,
  runShellCommand,
  startBackgroundServer,
  extractOutputs,
  resolveInside,
  listDirectoryContents,
  readTextFileContents,
  writeTextFileContents,
  truncate,
  type Workspace,
} from './workspace.ts';
import {
  searchNpmPackages as registrySearch,
  getDependencyTypes as registryTypes,
} from './npmRegistry.ts';

export interface ToolContext {
  signal: AbortSignal | undefined;
  status: (message: string) => void;
  warn: (message: string) => void;
  config: ChatConfig;
}

const NodeDependency = z.object({
  name: z.string().describe('npm package name, e.g. lodash'),
  version: z
    .string()
    .optional()
    .describe('npm package version range, e.g. ^4.17.21'),
});

function depsToRecord(dependencies: Array<{ name: string; version?: string }>): Record<string, string> {
  return Object.fromEntries(
    dependencies.map(({ name, version }) => [name, version && version.length ? version : '*'])
  );
}

// ---------------------------------------------------------------------------
// sandbox_initialize
// ---------------------------------------------------------------------------
export async function sandboxInitialize(
  args: { image?: string; port?: number },
  ctx: ToolContext
): Promise<string> {
  // No Docker here: these inputs have no effect, but tell the model.
  if (args.image) {
    ctx.warn(
      `The requested Docker image "${args.image}" is ignored; scripts run directly in LM Studio's Node.js.`
    );
  }
  if (args.port) {
    ctx.warn(`Mapping a container port is not supported; use run_js with listenOnPort instead.`);
  }

  const ws = await createWorkspace(ctx.config.outputFolder);
  ctx.status(`Created sandbox workspace ${ws.id}`);
  return ws.id;
}

// ---------------------------------------------------------------------------
// sandbox_exec
// ---------------------------------------------------------------------------
export async function sandboxExec(
  args: { container_id: string; commands: string[] },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}". Initialize one first.`;

  const outputs: string[] = [];
  for (const command of args.commands) {
    const safe = sanitizeShellCommand(command);
    if (!safe) {
      return `Cannot run command as it contains dangerous metacharacters: ${truncate(command, 500)}`;
    }
    ctx.status('Running command...');
    const result = await runShellCommand(ws, safe, {
      timeoutMs: ctx.config.runScriptTimeoutSeconds * 1000,
      signal: ctx.signal,
    });
    outputs.push(result.stdout);
    if (result.stderr) outputs.push(result.stderr);
    if (result.timedOut) outputs.push('\n[command timed out and was cancelled]');
    else if (result.code !== 0)
      outputs.push(`\n[command exited with code ${result.code}]`);
  }

  return outputs.join('\n').trim() || '(no output)';
}

// ---------------------------------------------------------------------------
// run_js
// ---------------------------------------------------------------------------
export async function runJs(
  args: {
    container_id: string;
    code: string;
    dependencies?: Array<{ name: string; version?: string }>;
    listenOnPort?: number;
  },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}". Initialize one first.`;

  const code = args.code ?? '';
  const dependencies = args.dependencies ?? [];
  const timeoutMs = ctx.config.runScriptTimeoutSeconds * 1000;

  await writeScript(ws, code, depsToRecord(dependencies));

  // Detached / background server mode.
  if (args.listenOnPort) {
    ctx.status('Starting background server...');
    const server = await startBackgroundServer(ws, {
      port: args.listenOnPort,
      timeoutMs: 10_000,
      signal: ctx.signal,
    });
    return server.ok
      ? server.message
      : `Error: ${server.message}`;
  }

  const telemetry: Record<string, unknown> = {};

  if (dependencies.length > 0) {
    ctx.status('Installing npm dependencies...');
    const install = await runNpmInstall(ws, { signal: ctx.signal });
    telemetry.installTimeMs = undefined;
    if (install.output.trim()) telemetry.installOutput = install.output.trim();
    if (!install.ok) {
      ctx.warn(install.error ?? 'npm install failed.');
    }
  }

  const start = Date.now();
  ctx.status('Running script...');
  const result = await runNodeScript(ws, { timeoutMs, signal: ctx.signal });
  const runTimeMs = Date.now() - start;
  telemetry.runTimeMs = runTimeMs;

  const files = await extractOutputs(ws, ctx.config.outputFolder);

  if (result.timedOut) {
    return `Error: Script timed out after ${timeoutMs / 1000}s and was cancelled.\n\n${
      result.stderr ? `Stderr:\n${result.stderr}\n\n` : ''
    }Telemetry:\n${JSON.stringify(telemetry, null, 2)}`;
  }
  if (result.code !== 0) {
    return `Error: Script exited with code ${result.code}.\n\n${
      result.stderr ? `Stderr:\n${result.stderr}\n\n` : ''
    }Telemetry:\n${JSON.stringify(telemetry, null, 2)}`;
  }

  const sections = ['Node.js process output:', result.stdout.trim() || '(no output)'];
  if (files) sections.push(files);
  sections.push(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`);
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// run_js_ephemeral
// ---------------------------------------------------------------------------
export async function runJsEphemeral(
  args: {
    image?: string;
    code: string;
    dependencies?: Array<{ name: string; version?: string }>;
  },
  ctx: ToolContext
): Promise<string> {
  if (args.image) {
    ctx.warn(`The requested Docker image "${args.image}" is ignored; scripts run directly in LM Studio's Node.js.`);
  }

  const code = args.code ?? '';
  const dependencies = args.dependencies ?? [];
  const timeoutMs = ctx.config.runScriptTimeoutSeconds * 1000;

  const ws = await createWorkspace(ctx.config.outputFolder);
  try {
    await writeScript(ws, code, depsToRecord(dependencies));

    const telemetry: Record<string, unknown> = {};
    if (dependencies.length > 0) {
      ctx.status('Installing npm dependencies...');
      const install = await runNpmInstall(ws, { signal: ctx.signal });
      if (install.output.trim()) telemetry.installOutput = install.output.trim();
      if (!install.ok) ctx.warn(install.error ?? 'npm install failed.');
    }

    const start = Date.now();
    ctx.status('Running script...');
    const result = await runNodeScript(ws, { timeoutMs, signal: ctx.signal });
    telemetry.runTimeMs = Date.now() - start;

    if (result.timedOut) {
      return `Error: Script timed out after ${timeoutMs / 1000}s and was cancelled.\n\n${
        result.stderr ? `Stderr:\n${result.stderr}\n\n` : ''
      }Telemetry:\n${JSON.stringify(telemetry, null, 2)}`;
    }
    if (result.code !== 0) {
      return `Error: Script exited with code ${result.code}.\n\n${
        result.stderr ? `Stderr:\n${result.stderr}\n\n` : ''
      }Telemetry:\n${JSON.stringify(telemetry, null, 2)}`;
    }

    const sections = ['Node.js process output:', result.stdout.trim() || '(no output)'];
    const files = await extractOutputs(ws, ctx.config.outputFolder);
    if (files) sections.push(files);
    sections.push(`Telemetry:\n${JSON.stringify(telemetry, null, 2)}`);
    return sections.join('\n');
  } finally {
    await removeWorkspace(ws);
  }
}

// ---------------------------------------------------------------------------
// sandbox_stop
// ---------------------------------------------------------------------------
export async function sandboxStop(
  args: { container_id: string },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}".`;
  await removeWorkspace(ws);
  ctx.status(`Removed sandbox ${id}`);
  return `Sandbox ${args.container_id} removed.`;
}

// ---------------------------------------------------------------------------
// get_dependency_types
// ---------------------------------------------------------------------------
export async function getDependencyTypes(
  args: { dependencies: Array<{ name: string; version?: string }> },
  ctx: ToolContext
): Promise<string> {
  const dependencies = args.dependencies ?? [];
  if (dependencies.length === 0) return 'No dependencies provided.';
  try {
    return await registryTypes(dependencies, ctx.signal);
  } catch (err) {
    return `Error: Failed to fetch type info: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// search_npm_packages
// ---------------------------------------------------------------------------
export async function searchNpmPackages(
  args: {
    searchTerm: string;
    qualifiers?: {
      author?: string;
      maintainer?: string;
      scope?: string;
      keywords?: string;
      not?: string;
      is?: string;
      boostExact?: string;
    };
  },
  ctx: ToolContext
): Promise<string> {
  if (!args.searchTerm || !args.searchTerm.trim()) {
    return 'Error: Search term cannot be empty.';
  }
  try {
    return await registrySearch(args, ctx.signal);
  } catch (err) {
    return `Error: Failed to search npm packages for "${args.searchTerm}". Error: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}


// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------
export async function listDirectory(
  args: { container_id: string; path?: string },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}". Initialize one first.`;

  const res = await listDirectoryContents(ws.filesDir, args.path);
  if (res.error) return `Error: ${res.error}`;
  if (res.entries.length === 0) return 'The directory is empty.';
  return 'Directory contents:\n' + res.entries.map((e) => '  ' + e).join('\n');
}

// ---------------------------------------------------------------------------
// read_text_file
// ---------------------------------------------------------------------------
export async function readTextFile(
  args: { container_id: string; path: string },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}". Initialize one first.`;

  const resolved = resolveInside(ws.filesDir, args.path);
  if (!resolved) {
    return `Error: Path "${truncate(args.path, 200)}" is outside the sandbox's output folder.`;
  }

  const r = await readTextFileContents(resolved);
  if (!r.ok || r.content === undefined) {
    return `Error: ${r.error ?? 'Could not read file.'}`;
  }
  return `File content (${r.content.length} chars):\n${r.content}`;
}

// ---------------------------------------------------------------------------
// write_text_file
// ---------------------------------------------------------------------------
export async function writeTextFile(
  args: { container_id: string; path: string; content: string },
  ctx: ToolContext
): Promise<string> {
  const id = sanitizeWorkspaceId(args.container_id);
  if (!id) return 'Invalid container ID.';
  const ws = getWorkspace(id);
  if (!ws) return `No sandbox with id "${args.container_id}". Initialize one first.`;

  const resolved = resolveInside(ws.filesDir, args.path);
  if (!resolved) {
    return `Error: Path "${truncate(args.path, 200)}" is outside the sandbox's output folder.`;
  }

  const r = await writeTextFileContents(resolved, args.content ?? '');
  if (!r.ok) return `Error: ${r.error ?? 'Could not write file.'}`;
  return `Wrote "${args.path}" to the sandbox's output folder.`;
}
