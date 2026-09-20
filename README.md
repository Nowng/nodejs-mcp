# Node.js Sandbox — LM Studio Plugin

A [LM Studio](https://lmstudio.ai/ **)**Plugin** written in TypeScript that gives the LLM a set of tools to run arbitrary JavaScript (ESM) directly inside LM Studio's Node.js environment. It is a port of the standalone [`node-code-sandbox-mcp`](https://github.com/alfonsograziano/node-code-sandbox-mcp) MCP server by **Alfonso Graziano**, reworked to follow the [LM Studio Plugin SDK](https://lmstudio.ai/docs/developer) spec — replacing Docker with a local, in-process sandbox. We are grateful to Alfonso for open-sourcing the original and releasing it as MIT-licensed, which made this port possible.

> **No Docker.** Each "sandbox" is a local workspace directory and each script is run by spawning the same Node.js that runs this plugin. Write output files to the configured **Output Folder** so they are kept and returned.

## Tools

| Tool | What it does |
| --- | --- |
| `sandbox_initialize` | Start a sandbox; returns an id for the other tools. |
| `sandbox_exec` | Run shell commands inside a running sandbox (backticks / `$()` blocked). |
| `run_js` | Run an ESM script in a sandbox, optionally installing npm dependencies. `listenOnPort` keeps a server running in the background (best-effort). |
| `run_js_ephemeral` | Run an ESM script in a disposable workspace with optional deps, then clean up. |
| `list_directory` | List the files/subdirectories in a sandbox's output folder (optionally a subdirectory via `path`). |
| `read_text_file` | Read a text file from a sandbox's output folder and return its contents (binary files are rejected). |
| `write_text_file` | Write a text file into a sandbox's output folder so it is kept and returned by later runs. |
| `sandbox_stop` | Remove a running sandbox. |
| `search_npm_packages` | Search the npm registry and return name / description / README snippet (needs network). |
| `get_dependency_types` | Report each package's version and whether it ships `.d.ts` / `@types` (needs network). |

## Configuration (per chat)

Set from each chat's plugin settings:

- **Script Timeout (seconds)** — max time a single run may take before cancellation.
- **Workspace Lifetime (seconds)** — when an idle sandbox is auto-removed.
- **Output Folder** — subfolder where scripts should write files to keep them.

## Development

```bash
npm install      # installs @lmstudio/sdk and zod
npm run build    # tsc -> dist/
npm run dev      # lms dev  (hot-reload inside LM Studio)
npm run push     # publish to the LM Studio Hub
```

## Security

This plugin runs **arbitrary user code** inside LM Studio's Node.js environment. Only install plugins you trust, and keep the Output Folder scoped to a folder you control.

## Acknowledgments & License

This plugin is a port of [`node-code-sandbox-mcp`](https://github.com/alfonsograziano/node-code-sandbox-mcp), created and open-sourced by **Alfonso Graziano**. We sincerely thank him for building the original and releasing it under the MIT License, which made this adaptation possible.

This project is licensed under the [MIT License](LICENSE) — the same license as the original. See the full text in [`LICENSE`](LICENSE). The original copyright notice is retained as required by the MIT License.
