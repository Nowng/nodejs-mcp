import { type PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider.ts";
import { configSchematics, globalConfigSchematics } from "./config.ts";

/**
 * LM Studio plugin entry point.
 *
 * The generated `.lmstudio/entry.ts` calls this as `module.main(pluginContext)`,
 * so it must be a NAMED export (`main`) for `module.main` to resolve. Register
 * the tools and configuration here using the PluginContext.
 */
export async function main(ctx: PluginContext): Promise<void> {
  ctx.withToolsProvider(toolsProvider);
  ctx.withConfigSchematics(configSchematics);
  ctx.withGlobalConfigSchematics(globalConfigSchematics);
}

// Also expose the pieces directly (handy for tests / reuse).
export { toolsProvider, configSchematics, globalConfigSchematics };
