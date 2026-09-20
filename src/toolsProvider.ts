import {
  tool,
  type Tool,
  type ToolCallContext,
  ToolsProviderController,
} from "@lmstudio/sdk";
import { z } from "zod";

import {
  configSchematics,
  globalConfigSchematics,
  DEFAULT_CONFIG,
  type ChatConfig,
} from "./config.ts";
import * as core from "./core/handlers.ts";

/**
 * Builds the tools that LM Studio exposes to the LLM. Each tool wraps a pure
 * handler from `src/core/handlers.ts`, mapping the SDK's ToolCallContext
 * ({ status, warn, signal }) onto the handler's execution context and reading
 * the per-chat configuration.
 */
export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
  const config = readChatConfig(ctl);

  const toCtx = (ctx: ToolCallContext): core.ToolContext => ({
    signal: ctx.signal,
    status: ctx.status,
    warn: ctx.warn,
    config,
  });

  return [
    tool({
      name: "sandbox_initialize",
      description:
        "Start a new isolated sandbox for running Node.js code. Returns a sandbox id that the other tools use. Runs directly in LM Studio's Node.js (no Docker). Write output files to the configured Output Folder so they are kept.",
      parameters: {
        image: z
          .string()
          .optional()
          .describe("Ignored (no Docker). Kept for parity with older versions."),
        port: z
          .number()
          .optional()
          .describe("Ignored (no Docker). Kept for parity with older versions."),
      },
      implementation: async (
        args: { image?: string; port?: number },
        ctx: ToolCallContext
      ) => core.sandboxInitialize(args, toCtx(ctx)),
    }),

    tool({
      name: "sandbox_exec",
      description:
        "Run one or more shell commands inside a running sandbox. Each command runs in the sandbox's working directory. Returns the combined stdout/stderr. Dangerous metacharacters (backticks, $()) are blocked.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
        commands: z
          .array(z.string().min(1))
          .describe("Shell commands to run, in order."),
      },
      implementation: async (
        args: { container_id: string; commands: string[] },
        ctx: ToolCallContext
      ) => core.sandboxExec(args, toCtx(ctx)),
    }),

    tool({
      name: "run_js",
      description:
        "Run a JavaScript (ESM) script inside a running sandbox. Optionally installs npm dependencies first. If listenOnPort is set, keeps a server running in the background (best-effort). To keep any files your script creates, write them to the Output Folder; they are returned with the result. Call sandbox_stop when done. Use list_directory, read_text_file, and write_text_file to inspect or create files between runs.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
        code: z
          .string()
          .describe("JavaScript (ESM) code to run inside the sandbox."),
        dependencies: z
          .array(
            z.object({
              name: z.string().describe("npm package name, e.g. lodash"),
              version: z
                .string()
                .optional()
                .describe("npm package version range, e.g. ^4.17.21"),
            })
          )
          .default([])
          .describe(
            "npm dependencies to install before running the code. Each needs a name and optional version range."
          ),
        listenOnPort: z
          .number()
          .optional()
          .describe(
            "If set, leaves a server running in the background and exposes this port (best-effort)."
          ),
      },
      implementation: async (
        args: {
          container_id: string;
          code: string;
          dependencies?: Array<{ name: string; version?: string }>;
          listenOnPort?: number;
        },
        ctx: ToolCallContext
      ) => core.runJs(args, toCtx(ctx)),
    }),

    tool({
      name: "run_js_ephemeral",
      description:
        "Run a JavaScript (ESM) snippet in a disposable workspace with optional npm dependencies, then clean up automatically. To keep any files your script creates, write them to the Output Folder; they are returned with the result. Ideal for one-shot runs. Use list_directory/read_text_file/write_text_file to manage files.",
      parameters: {
        image: z
          .string()
          .optional()
          .describe("Ignored (no Docker). Kept for parity with older versions."),
        code: z
          .string()
          .describe("JavaScript (ESM) code to run in a disposable workspace."),
        dependencies: z
          .array(
            z.object({
              name: z.string().describe("npm package name, e.g. lodash"),
              version: z
                .string()
                .optional()
                .describe("npm package version range, e.g. ^4.17.21"),
            })
          )
          .default([])
          .describe(
            "npm dependencies to install before running the code. Each needs a name and optional version range."
          ),
      },
      implementation: async (
        args: {
          image?: string;
          code: string;
          dependencies?: Array<{ name: string; version?: string }>;
        },
        ctx: ToolCallContext
      ) => core.runJsEphemeral(args, toCtx(ctx)),
    }),

    tool({
      name: "sandbox_stop",
      description:
        "Terminate and remove a running sandbox. Call this after you are done with a sandbox started with sandbox_initialize.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
      },
      implementation: async (
        args: { container_id: string },
        ctx: ToolCallContext
      ) => core.sandboxStop(args, toCtx(ctx)),
    }),

    tool({
      name: "search_npm_packages",
      description:
        "Search the npm registry for packages by a term and get each package's name, description, and a README snippet. Use + to combine terms (e.g. 'react+components'). Optionally filter with qualifiers like { author: 'sindresorhus' } or { not: 'deprecated' }. Requires network access.",
      parameters: {
        searchTerm: z
          .string()
          .min(1)
          .describe(
            "Term to search npm for. Use + to combine terms, e.g. 'react+components'."
          ),
        qualifiers: z
          .object({
            author: z.string().optional().describe("Filter by author name."),
            maintainer: z
              .string()
              .optional()
              .describe("Filter by maintainer name."),
            scope: z
              .string()
              .optional()
              .describe("Filter by npm scope, e.g. '@vue'."),
            keywords: z.string().optional().describe("Filter by keywords."),
            not: z.string().optional().describe("Exclude matching packages."),
            is: z.string().optional().describe("Include only matching packages."),
            boostExact: z
              .string()
              .optional()
              .describe("Boost exact matches for this term."),
          })
          .optional()
          .describe("Optional filters, e.g. { author: 'sindresorhus' } or { not: 'deprecated' }."),
      },
      implementation: async (
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
        ctx: ToolCallContext
      ) => core.searchNpmPackages(args, toCtx(ctx)),
    }),

    tool({
      name: "get_dependency_types",
      description:
        "Given npm package names (and optional versions), report each one's version and whether it ships TypeScript types (.d.ts / 'types') or has a matching @types/... package. Requires network access.",
      parameters: {
        dependencies: z
          .array(
            z.object({
              name: z.string().describe("npm package name."),
              version: z.string().optional().describe("Version range, e.g. ^4.17.21."),
            })
          )
          .describe("npm packages to inspect for bundled @types / .d.ts files."),
      },
      implementation: async (
        args: { dependencies: Array<{ name: string; version?: string }> },
        ctx: ToolCallContext
      ) => core.getDependencyTypes(args, toCtx(ctx)),
    }),

    tool({
      name: "list_directory",
      description:
        "List the files and subdirectories in a sandbox's output folder (the folder where scripts write files to keep). Optionally list a subdirectory via `path`; entries ending with / are directories. Use it to see what a script produced between runs.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
        path: z
          .string()
          .optional()
          .describe("Optional subdirectory to list (relative to the output folder). Defaults to the output folder root."),
      },
      implementation: async (
        args: { container_id: string; path?: string },
        ctx: ToolCallContext
      ) => core.listDirectory(args, toCtx(ctx)),
    }),

    tool({
      name: "read_text_file",
      description:
        "Read a TEXT file from a sandbox's output folder and return its contents. Only works on text files (binary files are rejected); long files are truncated. Use it to inspect files your script created.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
        path: z
          .string()
          .describe("Path of the file to read, relative to the output folder, e.g. 'hello.txt' or 'notes/data.txt'."),
      },
      implementation: async (
        args: { container_id: string; path: string },
        ctx: ToolCallContext
      ) => core.readTextFile(args, toCtx(ctx)),
    }),

    tool({
      name: "write_text_file",
      description:
        "Write a TEXT file into a sandbox's output folder so it is kept and returned by later runs. Creates parent directories as needed.",
      parameters: {
        container_id: z.string().describe("Sandbox id from sandbox_initialize."),
        path: z
          .string()
          .describe("Path to write, relative to the output folder, e.g. 'notes.txt'."),
        content: z
          .string()
          .describe("The text content to write."),
      },
      implementation: async (
        args: { container_id: string; path: string; content: string },
        ctx: ToolCallContext
      ) => core.writeTextFile(args, toCtx(ctx)),
    }),
  ];
}

function readChatConfig(ctl: ToolsProviderController): ChatConfig {
  const c = ctl.getPluginConfig(configSchematics);
  return {
    runScriptTimeoutSeconds: finiteOr(
      c.get("runScriptTimeoutSeconds"),
      DEFAULT_CONFIG.runScriptTimeoutSeconds
    ),
    workspaceTimeoutSeconds: finiteOr(
      c.get("workspaceTimeoutSeconds"),
      DEFAULT_CONFIG.workspaceTimeoutSeconds
    ),
    outputFolder:
      (c.get("outputFolder") as string | undefined) ??
      DEFAULT_CONFIG.outputFolder,
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
