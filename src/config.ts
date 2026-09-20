import { createConfigSchematics } from "@lmstudio/sdk";

/** Per-chat configuration values, as read by the tools. */
export interface ChatConfig {
  runScriptTimeoutSeconds: number;
  workspaceTimeoutSeconds: number;
  outputFolder: string;
}

export const DEFAULT_CONFIG: ChatConfig = {
  runScriptTimeoutSeconds: 30,
  workspaceTimeoutSeconds: 3600,
  outputFolder: "files",
};

/**
 * Per-chat configuration. Shown in each chat's plugin settings and used by the tools.
 * Note: numeric fields use the "numeric" value-type token (not "number").
 */
export const configSchematics = createConfigSchematics()
  .field(
    "runScriptTimeoutSeconds",
    "numeric",
    {
      displayName: "Script Timeout (seconds)",
      subtitle:
        "Max time a single script run may take before it is cancelled. Between 1 and 3600.",
      min: 1,
      max: 3600,
    },
    30
  )
  .field(
    "workspaceTimeoutSeconds",
    "numeric",
    {
      displayName: "Workspace Lifetime (seconds)",
      subtitle:
        "A sandbox workspace is auto-removed after being idle this long. Between 60 and 86400.",
      min: 60,
      max: 86400,
    },
    3600
  )
  .field(
    "outputFolder",
    "string",
    {
      displayName: "Output Folder",
      subtitle:
        "Subfolder inside each sandbox where your script should write files so they are kept and returned.",
    },
    "files"
  )
  .build();

/** Global configuration (applies to all chats). None required for this plugin. */
export const globalConfigSchematics = createConfigSchematics().build();
