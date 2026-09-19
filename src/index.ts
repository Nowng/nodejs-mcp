/**
 * LM Studio Plugin entry point.
 *
 * Exposes the tool provider and configuration schematics that LM Studio loads.
 * The actual tool logic lives in src/toolsProvider.ts and delegates to the
 * Docker-free local engine (src/sandboxLocal.ts) plus docker-free helpers
 * imported from the pristine upstream node-code-sandbox-mcp repository.
 *
 * The upstream repo is cloned & built automatically by the npm `postinstall`
 * hook (scripts/setup.cjs). If it is missing/unbuilt, we throw a friendly,
 * actionable error HERE — before importing the modules that depend on it — so
 * the failure is recoverable (`npm run setup`) instead of a bare
 * ERR_MODULE_NOT_FOUND from the static import graph.
 *
 * NOTE: This entry point is bundled by `lms dev` into CommonJS. Therefore it
 * MUST NOT use `import.meta.url` or top-level `await`, both of which are
 * incompatible with the "cjs" output format used by the LM Studio runtime.
 * Use `__dirname` and static imports instead (see below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { type PluginContext } from '@lmstudio/sdk';

import { toolsProvider } from './toolsProvider.js';
import { configSchematics, globalConfigSchematics } from './config.js';

// `__dirname` is provided by the CommonJS bundler; this replaces the previous
// `path.dirname(fileURLToPath(import.meta.url))` which esbuild cannot emit.
const UPSTREAM_READY = path.resolve(
  __dirname,
  '../node-code-sandbox-mcp/dist/config.js',
);

if (!fs.existsSync(UPSTREAM_READY)) {
  throw new Error(
    'nodejs-mcp: the upstream "node-code-sandbox-mcp" tree is missing or not built.\n' +
      '  • Regenerate it now:  npm run setup\n' +
      '  • Or a full rebuild:   npm run build\n' +
      '  • This normally happens automatically via the npm "postinstall" hook during\n' +
      '    Hub install. Make sure `git` and network access are available at install time.',
  );
}

/**
 * LM Studio plugin entry point.
 *
 * The generated `.lmstudio/entry.ts` bootstrap loads this module and invokes
 * `main(pluginContext)`. We register the tool provider and configuration
 * schematics through the plugin context so LM Studio can consume them.
 *
 * @param pluginContext - Context object provided by LM Studio used to register
 *   tools, config schematics, prompt preprocessors, generators, etc.
 */
export async function main(pluginContext: PluginContext): Promise<void> {
  pluginContext.withConfigSchematics(configSchematics);
  pluginContext.withGlobalConfigSchematics(globalConfigSchematics);
  pluginContext.withToolsProvider(toolsProvider);
}
