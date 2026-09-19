import { tool, Tool, ToolsProviderController } from '@lmstudio/sdk';

import { configSchematics, globalConfigSchematics } from './config.js';
import {
  initializeSchema,
  execSchema,
  runJsSchema,
  stopSchema,
  ephemeralSchema,
  searchNpmSchema,
  initializeLocal,
  execLocal,
  runJsLocal,
  stopLocal,
  runJsEphemeralLocal,
  readTextFileLocal,
  readTextFileSchema,
  EngineContext,
  responseToText,
  resolveWorkspacePath,
} from './sandboxLocal.js';
import { searchNpmPackagesLocal, getDependencyTypes, argSchema as getDepsSchema } from './networkTools.js';

/**
 * Tools Provider.
 *
 * Exposes the node-code-sandbox-mcp toolset to LM Studio models using Docker-free
 * local execution. Each tool is a thin wrapper that delegates to the shared core
 * (src/sandboxLocal.ts / src/networkTools.ts). The pristine upstream repo is only
 * imported for its docker-free helpers and get_dependency_types, so it can keep
 * being updated via `git pull` without touching this code.
 */
export async function toolsProvider(
  ctl: ToolsProviderController,
): Promise<Tool[]> {
  const globalConfig = ctl.getGlobalPluginConfig(globalConfigSchematics);
  const workspacePathRaw = globalConfig.get('workspacePath');

  // Single source of truth for the working path. We mirror it into
  // process.env so any reused upstream helper that reads FILES_DIR agrees.
  const workspacePath = resolveWorkspacePath(workspacePathRaw);
  process.env.FILES_DIR = workspacePath;

  const perChat = ctl.getPluginConfig(configSchematics);
  const enabled = perChat.get('enabled');
  if (!enabled) return [];

  const ctx: EngineContext = { workspacePath };

  return [
    tool({
      name: 'sandbox_initialize',
      description:
        'Start a new isolated Node.js sandbox session (local, no Docker). Returns a session id used by the other tools.',
      parameters: initializeSchema,
      implementation: async ({ image, port }) =>
        responseToText(await initializeLocal({ image, port }, ctx)),
    }),

    tool({
      name: 'sandbox_exec',
      description:
        'Execute one or more shell commands inside a running sandbox session. Requires a session id from sandbox_initialize.',
      parameters: execSchema,
      implementation: async ({ container_id, commands }) =>
        responseToText(await execLocal({ container_id, commands }, ctx)),
    }),

    tool({
      name: 'run_js',
      description:
        'Install npm dependencies and run JavaScript (ESModule) code inside a running sandbox session. After running, call sandbox_stop to free resources.',
      parameters: runJsSchema,
      implementation: async ({ container_id, code, dependencies, listenOnPort }) =>
        responseToText(
          await runJsLocal({ container_id, code, dependencies, listenOnPort }, ctx)
        ),
    }),

    tool({
      name: 'sandbox_stop',
      description:
        'Terminate and remove a running sandbox session. Call this after finishing work in a session started with sandbox_initialize.',
      parameters: stopSchema,
      implementation: async ({ container_id }) =>
        responseToText(await stopLocal({ container_id }, ctx)),
    }),

    tool({
      name: 'run_js_ephemeral',
      description:
        'Run a JavaScript (ESModule) snippet in a disposable local sandbox with optional npm dependencies, then auto-cleanup. Files saved during the run are copied to the workspace path and returned.',
      parameters: ephemeralSchema,
      implementation: async ({ image, code, dependencies }) =>
        responseToText(
          await runJsEphemeralLocal({ image, code, dependencies }, ctx)
        ),
    }),

    tool({
      name: 'read_text_file',
      description:
        'List the contents of a directory OR read a UTF-8 text file from the workspace, depending on the path. Pass a directory path (e.g. "out" or "sessions/js-sbx-...") to get a listing; pass a file path (e.g. "report.json") to get its text. Paths are resolved relative to the workspace root and must stay inside it. Use maxBytes to cap how many bytes are read from a file.',
      parameters: readTextFileSchema,
      implementation: async ({ path, maxBytes }) =>
        responseToText(await readTextFileLocal({ path, maxBytes }, ctx)),
    }),

    tool({
      name: 'search_npm_packages',
      description:
        'Search npm packages by a term and get their name, description, latest version, and a README snippet (top 5 by popularity). Use + to combine terms.',
      parameters: searchNpmSchema,
      implementation: async ({ searchTerm, qualifiers }) =>
        responseToText(
          await searchNpmPackagesLocal({ searchTerm, qualifiers })
        ),
    }),

    tool({
      name: 'get_dependency_types',
      description:
        'Given npm package names (and optional versions), return whether each ships TypeScript types or has an @types/… package, plus the raw .d.ts text.',
      parameters: getDepsSchema,
      implementation: async ({ dependencies }) =>
        responseToText(await getDependencyTypes({ dependencies })),
    }),
  ];
}
