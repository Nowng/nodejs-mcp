# nodejs-mcp

> An **LM Studio Plugin** that exposes the [`node-code-sandbox-mcp`](https://github.com/alfonsograziano/node-code-sandbox-mcp) toolset — *run JavaScript / shell in a sandbox, look up npm packages and their TypeScript types* — using **Docker‑free local execution**.
>
> This plugin is a thin **LM Studio SDK wrapper** around the pristine upstream repository. The upstream tree is cloned (and built) automatically at install time and is **never modified**, so it can keep being updated via `git pull` in its own worktree.

---

## Table of Contents

1. [Project description](#1-project-description)
2. [Development process](#2-development-process)
3. [Installation and usage](#3-installation-and-usage)
4. [MCP tools — feature summary (for humans)](#4-mcp-tools-feature-summary-for-humans)
5. [Example prompts with the `skills/nodejs-mcp.md` guide](#5-example-prompts-with-the-skillsnodejs-mcpmd-guide)
6. [License](#6-license)

---

## 1. Project description

`nodejs-mcp` is an **LM Studio Plugin** (not a standalone MCP server). It lets you
run real Node.js code on the host machine, install npm packages on demand, save
files, and start background servers — all without Docker.

It works by wrapping the upstream
[`node-code-sandbox-mcp`](https://github.com/alfonsograziano/node-code-sandbox-mcp)
project:

- The **Docker‑free** helpers from upstream (`types`, `utils`, `runUtils`,
  `snapshotUtils`, and `tools/getDependencyTypes`) are imported directly, so the
  upstream source tree stays pristine.
- The **5 Docker‑coupled execution tools** (`sandbox_initialize`,
  `sandbox_exec`, `run_js`, `sandbox_stop`, `run_js_ephemeral`) cannot use
  `docker run/exec/cp/rm` here, so they are **reimplemented locally** in
  `src/sandboxLocal.ts`. They keep the *same names and contracts*, but a plain
  local session directory replaces a Docker container.
- `search_npm_packages` is **reimplemented** against the public npm registry API
  in `src/networkTools.ts`, dropping the upstream's archived `npm-registry-sdk`
  dependency.

### Why this design

| Concern | Approach |
|---|---|
| Package format | LM Studio Plugin (`"type": "plugin"`, Node runner). Entry: `dist/index.js`. |
| Upstream reuse | Docker‑free helpers imported from the built upstream subtree. |
| Docker tools | Reimplemented locally in `src/sandboxLocal.ts` — same contracts, host execution. |
| `search_npm_packages` | Reimplemented against the public npm registry API (`src/networkTools.ts`). |
| Install step | `"postinstall": "node scripts/setup.cjs"` clones upstream (shallow) and builds only the docker‑free subset. |

### Tool list (8 tools)

1. `sandbox_initialize` — start a local sandbox session, returns a session id.
2. `sandbox_exec` — run shell commands inside a session.
3. `run_js` — install deps + run an ESModule inside a session.
4. `sandbox_stop` — tear down a session.
5. `run_js_ephemeral` — one‑shot disposable run; saved files are copied to the
   workspace and returned.
6. `search_npm_packages` — search npm (name / description / README snippet + latest version, top 5).
7. `get_dependency_types` — report whether a package ships types / an `@types/…`
   package, plus the raw `.d.ts`.
8. `read_text_file` — list a directory or read a UTF‑8 text file saved in the workspace (path is confined to the workspace root).

---

## 2. Development process

The workflow follows the standard LM Studio Plugin lifecycle described in the
[LM Studio SDK skill](https://github.com/lmstudio-ai). In short: create → edit
TypeScript → typecheck/lint/build → run in dev mode → push to Hub.

```bash
# 1. Create the plugin scaffold (run once, outside the project dir)
lms create
#   follow the prompts: name=nodejs-mcp, type=plugin, location=<project>, TypeScript=yes

# 2. Install dependencies AND run the postinstall hook.
#    This clones the pristine upstream repo and builds its docker-free subset.
npm install

# 3. Type-check, lint, and compile.
npm run typecheck
npm run lint          # optional, if a lint config is present
npm run build         # setup.cjs (ensure upstream subset built) then tsc

# 4. Develop inside LM Studio (auto-rebuilds on save).
npm run dev           # = lms dev

# 5. Test the tools from a model chat that supports tool calling.

# 6. Publish to the LM Studio Hub when ready.
npm run push          # = lms push
```

### What `npm install` actually does here

The `"postinstall"` script points at `scripts/setup.cjs`, which:

1. **Clones upstream shallowly** (`git clone --depth 1
   https://github.com/alfonsograziano/node-code-sandbox-mcp.git`) into
   `node-code-sandbox-mcp/` if it is not already present.
2. **Builds only the docker‑free subset** using this plugin's hoisted `tsc`
   (`tsconfig.upstream.json`), emitting `node-code-sandbox-mcp/dist/`.
3. Is **defensive**: it logs clearly and never throws, so a Hub install always
   succeeds even if network/git is unavailable (the plugin reports a friendly
   error at load time instead).

### Keeping upstream pristine

`node-code-sandbox-mcp/` is a shallow `git clone`. Only **generated** artifacts
live there:

- `dist/` — compiled docker‑free subset + emitted `.d.ts` (regenerated by
  `setup.cjs`).

The upstream **source** (`src/`, `*.md`, etc.) is untouched, so future
`git -C node-code-sandbox-mcp pull` / updates remain valid. This project never
edits files inside the clone. To start over:

```bash
npm run clean:upstream    # removes the cloned upstream tree only
npm install               # re-clones and rebuilds it
```

### Source layout

```
nodejs-mcp/
├── manifest.json            # LM Studio plugin manifest (name=nodejs-mcp, owner=hoonowng)
├── package.json             # deps + scripts + postinstall entry
├── tsconfig.json            # compiles src/ -> dist/
├── tsconfig.upstream.json   # builds ONLY the docker-free upstream subset we import
├── scripts/
│   └── setup.cjs            # postinstall: git clone upstream + build subset
├── skills/
│   └── nodejs-mcp.md        # LLM-facing skill guide (prompts + tool reference)
├── src/
│   ├── index.ts             # exports main() -> registers toolsProvider + config
│   ├── config.ts            # LM Studio UI schematics (workspace path, enable toggle)
│   ├── toolsProvider.ts     # the 8 tool wrappers (delegates to the shared core)
│   ├── sandboxLocal.ts      # Docker-free engine (sessions, npm/node exec, file changes)
│   └── networkTools.ts      # search_npm_packages (registry API) + get_dependency_types
├── dist/                    # compiled output (generated)
└── node-code-sandbox-mcp/   # pristine upstream clone (generated by postinstall; gitignored)
```

---

## 3. Installation and usage

### Requirements

- **LM Studio** installed and running (provides the bundled Node.js runtime).
- The `lms` CLI, if you want to develop/push (`npm run dev`, `npm run push`).
- **Outbound network access to the npm registry** — needed to install
  dependencies, search packages, and resolve types. This is the same network
  requirement as the upstream server's data tools.
- **No Docker required.** Sessions are plain directories on disk.

### Install from the LM Studio Hub

1. Open **Hub** in LM Studio.
2. Search for **`nodejs-mcp`** (owner `hoonowng`).
3. Click **Install**. The `postinstall` hook clones and builds the upstream
   subset automatically.
4. Open **Plugins**, find **nodejs-mcp**, and enable it.

> If installed from source instead of the Hub, run `npm install` first — this is
> what triggers the `postinstall` clone/build.

### Configure (optional)

The Plugin UI exposes two settings:

- **Workspace path** *(global)* — where session workspaces live and where files
  saved by scripts are copied. Defaults to `~/.nodejs-mcp`. This value is also
  mirrored into `FILES_DIR`, so the reused upstream helpers agree on a single
  working path.
- **Enable JS Sandbox Tools** *(per‑chat)* — hide all tools for one conversation.

> No secrets or API keys are stored.

### Run it

```bash
npm run dev            # compile + load into LM Studio, watch for changes
```

Then, in a chat with a model that supports tool calling:

1. Open the plugin list and confirm **nodejs-mcp** is enabled.
2. Send a request that needs to run code (see [section 5](#5-example-prompts-with-the-skillsnodejs-mcpmd-guide)).
3. The model will call the sandbox tools and return results inline.

To publish your own copy:

```bash
npm run typecheck && npm run lint && npm run build
npm run push           # = lms push   (add --private for a private artifact)
```

---

## 4. MCP tools — feature summary (for humans)

All tool names match the upstream project so existing workflows carry over. The
table below is written for **people**, not models.

| Tool | What it does | When to use |
|---|---|---|
| `run_js_ephemeral` | Runs a one‑shot script in a disposable folder, installs optional deps, and returns stdout **plus any files the script saved** (images as image content, other files as resource). | Most tasks: generate data, convert formats, produce an image/PDF, write a file. No cleanup needed. |
| `sandbox_initialize` | Creates a long‑lived session and returns a session id (`container_id`). | You need several steps in the same folder, or want to install heavy dependencies once and reuse them. |
| `run_js` | Writes JS + `package.json` into a session, installs deps, runs it, returns stdout (and file changes). Optional `listenOnPort` starts a **background** server. | Multi‑session work, or starting a long‑running server to test later. |
| `sandbox_exec` | Runs raw shell commands (`ls`, `mkdir`, `curl`, …) inside a session, returns combined output. | Inspect the filesystem, run CLI tools, curl a running server. |
| `sandbox_stop` | Ends and cleans up a session, deleting its working folder and killing any background server started via `listenOnPort`. **Always call this when you are done.** | When finished with a session — never leave it running. |
| `search_npm_packages` | Searches the npm registry (up to 5 results) by term; supports qualifiers (`scope`, `author`, `not`, `is`, `boostExact`, …). Returns name, description, README snippet, and latest version. | Finding the right package before writing code. Use `+` instead of spaces in the search term. |
| `get_dependency_types` | Checks whether a package ships TypeScript types or an `@types/…` package, and returns the raw `.d.ts`. | Learning an API's type signatures so you can write correct typed code. |
| `read_text_file` | Lists a directory or reads a UTF‑8 text file inside the workspace; accepts `maxBytes` to cap large files. Paths outside the workspace are rejected. | Inspecting artifacts saved by `run_js_ephemeral` / `run_js`, or browsing the `sessions/` folder before tearing a session down. |

### Behavior notes

- Code runs as **ES Modules** — use `import`, not `require`.
- Node built‑ins (`node:fs`, `node:http`, `node:path`, …) need no dependency entry.
- Any package you `import` **must** be listed in `dependencies` first, or install
  fails.
- Files saved by `run_js_ephemeral` are returned with the result **and** copied
  into the workspace. In a session, files live in the session folder under
  `sessions/<session-id>/` until you call `sandbox_stop`. Read them back with
  `read_text_file`, which can also list folders. All paths are confined to the
  workspace root — `../` escapes are blocked.
- Shell execution (`sandbox_exec`) and JS execution run **on the host with no
  container isolation** — scope your inputs accordingly.
- **Always end each session.** Whenever you start a session with
  `sandbox_initialize`, finish it by calling `sandbox_stop` with the same session
  id. Otherwise its working folder (and any background server started via
  `listenOnPort`) keeps running on the host until someone cleans it up.

---

## 5. Example prompts with the `skills/nodejs-mcp.md` guide

The file [`skills/nodejs-mcp.md`](skills/nodejs-mcp.md) is an LLM‑facing skill
that teaches the model *which* tool to call, *how* to shape the arguments, and
*how* to read results. Below are ready‑to‑try prompts a human can type into a
tool‑capable chat; each maps to a concrete tool call.

### Prompt 1 — Generate and save an image (one‑shot)

> **Prompt:** *"Create and run a JS script that generates a QR code for the URL
> `https://nodejs.org`, and save it as `qrcode.png`. Use the `qrcode` package."*

Model calls:

```jsonc
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import QRCode from 'qrcode';\nimport fs from 'node:fs/promises';\nawait QRCode.toFile('qrcode.png', 'https://nodejs.org');\nconsole.log('done');",
    "dependencies": [ { "name": "qrcode", "version": "^1.5.4" } ]
  }
}
```

Result: the `qrcode.png` **image** content plus console output.

### Prompt 2 — Transform data with a library (one‑shot)

> **Prompt:** *"Run a script that deduplicates `[1,1,2,3,3,4]` and prints the
> unique values and their sum using lodash."*

Model calls `run_js_ephemeral` with `dependencies: [{ "name": "lodash", "version": "^4.17.21" }]`.

### Prompt 3 — Find a package before coding

> **Prompt:** *"Find me an npm package that generates QR codes, then use the best
> match to create one for `https://example.com`."*

Model calls:

```jsonc
{
  "name": "search_npm_packages",
  "arguments": { "searchTerm": "qr+code+generator" }
}
```

then follows with `run_js_ephemeral` using the discovered package name.

### Prompt 4 — Learn a package's types, then use it

> **Prompt:** *"Check whether `axios` ships TypeScript types, then fetch
> `https://nodejs.org` and print the status code."*

Model calls:

```jsonc
{
  "name": "get_dependency_types",
  "arguments": { "dependencies": [ { "name": "axios" } ] }
}
```

reads the returned `.d.ts`, then calls `run_js_ephemeral` with
`dependencies: [{ "name": "axios", "version": "^1.7.9" }]`.

### Prompt 5 — Build a tiny server, test it, then tear down (session flow)

> **Prompt:** *"Start a background HTTP server on port 8080 that returns `ok`,
> curl it to confirm it responds, then stop the session."*

Model calls, in order:

```jsonc
// 1. start session
{ "name": "sandbox_initialize", "arguments": {} }

// 2. start server in background (listenOnPort) + save the returned container_id
{
  "name": "run_js",
  "arguments": { "container_id": "<session id>", "listenOnPort": 8080,
    "code": "import http from 'node:http';\nconst s = http.createServer((q,r)=>{r.writeHead(200);r.end('ok');});\ns.listen(8080,()=>console.log('listening'));" }
}

// 3. test it
{ "name": "sandbox_exec", "arguments": { "container_id": "<session id>", "commands": [ "curl -s http://localhost:8080" ] } }

// 4. stop
{ "name": "sandbox_stop", "arguments": { "container_id": "<session id>" } }
```

Result from `sandbox_exec`: `ok`.

### Prompt 6 — Save a file, then read it back (round-trip)

> **Prompt:** *"Write the JSON `{\"hello\":\"world\"}` to a file called
> `report.json`, then list the workspace and read `report.json` back to me."*

Model calls, in order:

```jsonc
// 1. create + save the file
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import fs from 'node:fs/promises';\nawait fs.writeFile('report.json', JSON.stringify({ hello: 'world' }, null, 2));\nconsole.log('saved');"
  }
}

// 2. list the workspace
{ "name": "read_text_file", "arguments": { "path": "." } }

// 3. read the saved file back
{ "name": "read_text_file", "arguments": { "path": "report.json" } }
```

Result of step 2 lists the files in the workspace; step 3 returns:

```text
File: /…/.nodejs-mcp/report.json
Size: 33 bytes
{
  "hello": "world"
}
```

Tip: `read_text_file` is handy whenever you want to inspect artifacts without
dropping to raw shell. Use `maxBytes` to cap very large files.

---

## 6. License

This plugin is distributed under the **MIT License**.

The wrapper code in this project (`src/`, `scripts/`, `manifest.json`,
`package.json`, `tsconfig*.json`, and `skills/nodejs-mcp.md`) is licensed under
MIT by **hoonowng**.

It reuses the **pristine** upstream repository
[`node-code-sandbox-mcp`](https://github.com/alfonsograziano/node-code-sandbox-mcp)
(licensed **MIT**, © alfonsograziano). Only the Docker‑free subset is cloned and
built automatically at install time; that subtree retains its own upstream
license and copyright notices. We never modify upstream source files.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
