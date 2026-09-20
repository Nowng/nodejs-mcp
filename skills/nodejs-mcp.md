# Skill: nodejs-mcp — run Node.js code in LM Studio

## What this plugin does
The **nodejs-mcp** plugin gives the AI tools to run JavaScript (ESM, `import`/`export`) inside **sandboxes**. Each sandbox is a local folder. There is **no Docker**. Write files to the **Output Folder** (default name `files`) to keep them and get them back later.

## Rules — follow these exactly
- Each tool returns **one text string**. If it starts with `Error:`, read why and retry.
- Use the `container_id` from `sandbox_initialize` in every other tool. Copy it each time.
- To **keep** a file, write it in your code to `./files/...` (the Output Folder; default name `files`). Files there are returned with results and can be read/listed later. Files written elsewhere are lost.
- Code must be **ESM**: use `import`/`export` and Node built-ins (`node:fs`, `node:path`, …). Use the global `fetch` for network, not `node-fetch`.
- `image`/`port` are **ignored** (no Docker). Do not set them.
- `read_text_file` reads **text only**. Binary files are refused; long files are cut off.
- Paths for `list_directory`, `read_text_file`, `write_text_file` are **relative to the Output Folder (e.g. `notes/hello.txt`). `../` is blocked.
- Shell commands in `sandbox_exec` cannot use backticks `` ` `` or `$()`.
- `search_npm_packages` and `get_dependency_types` need **internet**.
- Each tool call is one step. Read the result before the next step.

## Tools

### Sandbox tools

#### `sandbox_initialize`
Create a sandbox. Returns an id like `ws-1a2b3c…`.
Args: none needed (`image`/`port` are ignored).
```json
{ "name": "sandbox_initialize", "arguments": {} }
```
Result: the id string — use it in every later tool.

#### `run_js_ephemeral`
Run one script, then clean up automatically. Use for a single one-shot run.
Args: `code` (string, required); `dependencies`? (list of `{name, version?}`); `image`? (ignored).
```json
{ "name": "run_js_ephemeral", "arguments": { "code": "console.log('hi');" } }
```

#### `run_js`
Run a script in a **kept** sandbox. Use when you need several runs in the same place. Call `sandbox_stop` when done.
Args: `container_id` (string); `code (string); `dependencies`? (`{name,version?}`); `listenOnPort`? (number).
```json
{ "name": "run_js", "arguments": { "container_id": "ws-1a2b3c", "code": "console.log(2+2)", "dependencies": [ { "name": "lodash", "version": "^4.17.21" } ] } }
```

#### `sandbox_exec`
Run shell commands in a running sandbox. Each command runs in the sandbox's working folder. Returns stdout/stderr. No backticks or `$()`.
Args: `container_id (string); `commands (string list, in order).
```json
{ "name": "sandbox_exec", "arguments": { "container_id": "ws-1a2b3c", "commands": ["node --version"] } }
```

#### `sandbox_stop`
Delete a sandbox. Call it when you are done.
Args: `container_id (string).

### File tools — all need `container_id`
These work in the **Output Folder** (default `files`). Paths are relative to it.

#### `list_directory`
List files and subfolders. A folder name ends with `/`.
Args: `container_id (string); `path`? (string, a subfolder).
```json
{ "name": "list_directory", "arguments": { "container_id": "ws-1a2b3c" } }
```

#### `read_text_file`
Read a **text** file. Binary files are refused; long files are cut off.
Args: `container_id (string); `path (string), e.g. `notes/hello.txt`.
```json
{ "name": "read_text_file", "arguments": { "container_id": "ws-1a2b3c", "path": "notes/hello.txt" } }
```

#### `write_text_file`
Write a **text** file. Makes folders as needed.
Args: `container_id (string); `path` (string); `content (string).
```json
{ "name": "write_text_file", "arguments": { "container_id": "ws-1a2b3c", "path": "notes/todo.txt", "content": "buy milk" } }
```

### Network tools — needs internet

#### `search_npm_packages`
Search npm. Use `+` to join words, e.g. `react+components`.
Args: `searchTerm (string); `qualifiers (optional: author/maintainer/scope/keywords/not/is/bestExact).

#### `get_dependency_types`
Check if a package ships types (`.d.ts` or `@types`).
Args: `dependencies (list of `{name, version?}`.

## How to read results
- Each tool gives **one text string**. If it starts with `Error:`, the step failed — fix and retry.
- `run_js`/`run_js_ephemeral` add a `Telemetry:` block at the end (timing info). You can ignore it.
- To keep a file, your code must write it to `./files/...`. Then it appears in `list_directory` and can be read by `read_text_file`.

## Worked scenarios

### Scenario 1 — one-shot script that keeps a file
Goal: run a script that writes a file and prints a number.
1. Call `run_js_ephemeral` with this code:
   ```js
   import fs from "node:fs/promises";
   await fs.writeFile("./files/hello.txt", "hello world");
   console.log("result:", 6 * 7);
   ```
2. The result shows the console output, the saved file `hello.txt`, and a Telemetry block.

### Scenario 2 — keep a sandbox and read/write files
Goal: run several times and manage files.
1. `sandbox_initialize` → copy the `container_id`.
2. `run_js (with that `container_id`) — it runs in the same place each time.
3. `list_directory (with that `container_id`) — see what exists. Folders end with `/`.
4. `read_text_file (with a path like `notes/plan.txt`) — read it.
5. `write_text_file (with a path and `content`) — create or edit a file.
6. `sandbox_stop (with that `container_id`) when done.

### Scenario 3 — find an npm package before coding
Goal: pick a package, then run code that uses it.
1. `search_npm_packages with `searchTerm` (e.g. `qr`).
2. `get_dependency_types with the package name to see if it has types.
3. `run_js_ephemeral (or `run_js`) with `dependencies: [{ "name": "qr", "version": "^1.0.0" }]`.

## Config (per chat, optional)
- `Script Timeout` — max seconds per run (1–3600, default 30).
- `Workspace Lifetime` — seconds before an idle sandbox is removed (60–86400, default 3600).
- `Output Folder` — folder name for kept files (default `files`).
