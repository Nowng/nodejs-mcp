import { createConfigSchematics } from '@lmstudio/sdk';

/**
 * Per-chat configuration: applies only to the current conversation.
 */
export const configSchematics = createConfigSchematics()
  .field(
    'enabled',
    'boolean',
    {
      displayName: 'Enable JS Sandbox Tools',
      subtitle: 'Toggle all nodejs-mcp tools on/off for this chat.',
    },
    true,
  )
  .build();

/**
 * Global configuration: applies to every conversation.
 *
 * The "Workspace path" is where generated files (saved by scripts) and
 * per-session working directories live. It defaults to `~/.nodejs-mcp`.
 * We keep this value as the single source of truth so both this Plugin and
 * the underlying node-code-sandbox-mcp helpers agree on the same path.
 */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    'workspacePath',
    'string',
    {
      displayName: 'Workspace path',
      subtitle:
        'Directory used to store session workspaces and saved files (e.g. ~/.nodejs-mcp).',
    },
    '~/.nodejs-mcp',
  )
  .build();
