# Skills: Node.js Sandbox (`nodejs-mcp`)

## What this plugin is

`nodejs-mcp` lets you run **real JavaScript** on the host machine. You write a
script, the tool runs it with `node`, and you get back the output (and any files
the script saved).

- No Docker needed. The tool creates small working folders for you.
- Code is **ES Modules**. Use `import`, not `require`.
- You can install npm packages before running.
- You can save files; saved files are returned to you.
- You can start a background HTTP server and test its endpoints.

Think of it as: **"give me a place to run Node.js code, install packages if I
ask, and show me what happened."**

---

## Available tools

You have **8 tools**. Call them by exact name.

| # | Tool name | Use it when you need to... |
|---|-----------|----------------------------|
| 1 | `run_js_ephemeral` | Run a one-off script quickly (no setup). Best for most tasks. |
| 2 | `search_npm_packages` | Find npm packages by keyword (results include the latest version). |
| 3 | `get_dependency_types` | Check if a package has TypeScript types, and read them. |
| 4 | `sandbox_initialize` | Start a long-lived sandbox session (for multi-step work). |
| 5 | `run_js` | Run code inside an existing session (deps are reused). |
| 6 | `sandbox_exec` | Run raw shell commands inside an existing session. |
| 7 | `sandbox_stop` | End/clean up a session you started. |
| 8 | `read_text_file` | List a folder or read a text file saved in the workspace. |

**Rule of thumb:**
- Simple, single task → use **`run_js_ephemeral`**.
- Multi-step, or you want to install big dependencies once and reuse them → use the
  **session** tools: `sandbox_initialize` → (`run_js` / `sandbox_exec`) → `sandbox_stop`.

---

## Two ways to run code

### Pattern A — One-shot (use `run_js_ephemeral`)

```
run_js_ephemeral({ image?, dependencies[], code })
```

- Makes a fresh working folder, runs your code, cleans up automatically.
- If your code saves files, those files are **returned to you**.
- Great for: generate an image, convert data, compute something, write a file.

### Pattern B — Session (use `sandbox_initialize` → ... → `sandbox_stop`)

Use this when you need **several steps in the same folder**, or want to install
dependencies once and reuse them.

```
1. sandbox_initialize({ image?, port? })   → returns a session id (container_id)
2. run_js      ({ container_id, code, dependencies[], listenOnPort? })
   OR
   sandbox_exec({ container_id, commands[] })
3. sandbox_stop  ({ container_id })         → delete the session
```

The `container_id` from step 1 is required by every later tool in that session.
Always copy it and reuse it.

> ⚠️ **Always call `sandbox_stop`.** When you are finished with a session, call
> `sandbox_stop({ container_id })` to delete its working folder and kill any
> background server started via `listenOnPort`. Leaving a session running keeps
> its files and host processes alive until someone cleans them up.

**Detached mode:** if you pass `listenOnPort` to `run_js`, the script keeps
running in the background and exposes that port. Use this to start an HTTP
server, then test the endpoint with `sandbox_exec` (curl). Call `sandbox_stop`
when done.

---

## Tool reference (copy-ready examples)

### 1. `run_js_ephemeral` — one-off script

Inputs:
- `code` **(required)** — JavaScript (ES Modules) source.
- `dependencies` **(optional)** — list of packages to install first. Default `[]`.
- `image` **(optional)** — ignored (no Docker). You can omit it.

Dependency format is always an **array of `{ name, version }`**:

```jsonc
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import lodash from 'lodash';\nconsole.log(_.uniq([1,1,2,3,3]));",
    "dependencies": [ { "name": "lodash", "version": "^4.17.21" } ]
  }
}
```

Typical result (trimmed):

```text
Node.js process output:
[ 1, 2, 3 ]

Telemetry:
{ "installTimeMs": 812, "runTimeMs": 41 }
```

**Save a file** — saved files are returned automatically:

```jsonc
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import fs from 'node:fs/promises';\nawait fs.writeFile('hello.txt', 'Hello world!');\nconsole.log('Saved hello.txt');"
  }
}
```

The tool response will include the `hello.txt` file. Images (PNG/JPG) are
returned as **image** content; other files are returned as **resource** content.

---

### 2. `search_npm_packages` — find a package

Inputs:
- `searchTerm` **(required)** — keywords. **No spaces allowed.** Use `+` to
  combine terms (e.g. `"qr+code"`).
- `qualifiers` **(optional)** — filter results:
  `author`, `maintainer`, `scope` (e.g. `"@vue"`), `keywords`, `not`
  (exclude), `is` (include only), `boostExact`.

Returns up to **5** packages sorted by popularity, each with `name`,
`description`, a README snippet, and its latest **`version`** from the npm
registry. The `version` tells you what to install.

```jsonc
{
  "name": "search_npm_packages",
  "arguments": {
    "searchTerm": "qr+code+generator",
    "qualifiers": { "boostExact": "qrcode" }
  }
}
```

Result (trimmed):

```json
[
  {
    "name": "qrcode",
    "description": "Generate QR codes...",
    "readmeSnippet": "qrcode is for generating QR codes...",
    "version": "^1.5.4"
  }
]
```

Use this **before** writing code: find the right package name, then put it in
`dependencies`.

---

### 3. `get_dependency_types` — check TypeScript types

Inputs:
- `dependencies` **(required)** — list of `{ name, version? }`. `version` is
  optional; if omitted the latest version is used.

Returns, per package: `name`, `hasTypes` (boolean), and — if found — the raw
`.d.ts` text (`types`) plus `typesPackage` (an `@types/...` package) and
`version`.

```jsonc
{
  "name": "get_dependency_types",
  "arguments": {
    "dependencies": [
      { "name": "lodash", "version": "^4.17.21" },
      { "name": "axios" }
    ]
  }
}
```

Result (trimmed):

```json
[
  { "name": "lodash", "hasTypes": true, "typesPackage": "@types/lodash", "version": "4.17.13" },
  { "name": "axios", "hasTypes": true, "types": "export function axios(...): ...", "version": "1.7.9" }
]
```

Use this when you need type hints to write correct code.

---

### 4–7. Session tools (multi-step)

**Step 1 — start a session:**

```jsonc
{
  "name": "sandbox_initialize",
  "arguments": { "image": "node:lts-slim" }
}
```

Result: the `session id`, e.g. `js-sbx-ab12cd34ef56...`. Save this value as
`container_id`.

**Step 2a — run JavaScript in that session** (dependencies are installed once
and reused by later `run_js` calls):

```jsonc
{
  "name": "run_js",
  "arguments": {
    "container_id": "js-sbx-ab12cd34ef56",
    "code": "import fs from 'node:fs';\nconsole.log('cwd:', process.cwd());",
    "dependencies": [ { "name": "lodash", "version": "^4.17.21" } ]
  }
}
```

**Step 2b — run shell commands in that session** (e.g. `ls`, `mkdir`, `cat`):

```jsonc
{
  "name": "sandbox_exec",
  "arguments": {
    "container_id": "js-sbx-ab12cd34ef56",
    "commands": [ "ls -la", "mkdir -p out" ]
  }
}
```

**Step 3 — stop the session** (clean up):

```jsonc
{
  "name": "sandbox_stop",
  "arguments": { "container_id": "js-sbx-ab12cd34ef56" }
}
```

---

### 8. `read_text_file` — list a folder or read a file

Inputs:
- `path` **(required)** — path **relative to the workspace**. A directory path
  lists the folder; a file path returns its text. Do **not** use `../` to escape
  the workspace.
- `maxBytes` **(optional)** — for a text file, stop reading after this many
  bytes. Omit to read the whole file (useful for large files).

The workspace is where `run_js_ephemeral` copies saved files, and it also holds
each session's folder under `sessions/<session-id>/`.

**List the workspace root:**

```jsonc
{ "name": "read_text_file", "arguments": { "path": "." } }
```

Result:

```text
Directory: /home/.../.nodejs-mcp

Directories (1):
  sessions/

Files (3):
  notes.txt
  report.json
  tiny.png
```

**Read a saved text file:**

```jsonc
{ "name": "read_text_file", "arguments": { "path": "report.json" } }
```

Result:

```text
File: /home/.../.nodejs-mcp/report.json
Size: 33 bytes
{
  "hello": "world",
  "n": 42
}
```

**Read only part of a large file** (cap tokens):

```jsonc
{ "name": "read_text_file", "arguments": { "path": "big.txt", "maxBytes": 4096 } }
```

The tool will cut the text and add `[truncated: showing N of M bytes]`.

**Errors you may see:**
- `"../etc/passwd"` → `"...escapes the workspace directory."` (blocked).
- A missing file → `"...does not exist in the workspace."`

### Example 1 — Generate a QR code image (one-shot)

Goal: create a QR code for `https://nodejs.org` and save it as `qrcode.png`.

```jsonc
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import QRCode from 'qrcode';\nimport fs from 'node:fs/promises';\nawait QRCode.toFile('qrcode.png', 'https://nodejs.org');\nconsole.log('done');",
    "dependencies": [ { "name": "qrcode", "version": "^1.5.4" } ]
  }
}
```

The response returns the `qrcode.png` **image** plus the console output.

If you are unsure of the package name, call `search_npm_packages` first with
`"searchTerm": "qr+code"`.

---

### Example 2 — Transform data with a library (one-shot)

Goal: read a JSON string, remove duplicates, print the result.

```jsonc
{
  "name": "run_js_ephemeral",
  "arguments": {
    "code": "import lodash from 'lodash';\nconst nums = [1,1,2,3,3,4];\nconsole.log('unique:', _.uniq(nums));\nconsole.log('sum:', _.sum(nums));",
    "dependencies": [ { "name": "lodash", "version": "^4.17.21" } ]
  }
}
```

---

### Example 3 — Multi-step session: build a tiny server, then test it

Goal: start an HTTP server in the background, confirm it responds, then stop it.

Step 1 — start:

```jsonc
{ "name": "sandbox_initialize", "arguments": { } }
```

Save the returned `container_id`.

Step 2 — start a background server on port 8080 (`listenOnPort`):

```jsonc
{
  "name": "run_js",
  "arguments": {
    "container_id": "<the session id from step 1>",
    "listenOnPort": 8080,
    "code": "import http from 'node:http';\nconst s = http.createServer((req,res)=>{res.writeHead(200);res.end('ok');});\ns.listen(8080,()=>console.log('listening'));"
  }
}
```

Result says the server started in the background and its log path.

Step 3 — test it with curl via `sandbox_exec`:

```jsonc
{
  "name": "sandbox_exec",
  "arguments": {
    "container_id": "<the session id>",
    "commands": [ "curl -s http://localhost:8080" ]
  }
}
```

Result: `ok`.

Step 4 — stop the session:

```jsonc
{ "name": "sandbox_stop", "arguments": { "container_id": "<the session id>" } }
```

---

### Example 4 — Install a package, inspect its types, then use it

Goal: write code using `axios` correctly.

1. Call `get_dependency_types` with `[{ "name": "axios" }]`. Read the returned
   `.d.ts` to learn the API.
2. Call `run_js_ephemeral` with `dependencies: [{ "name": "axios", "version": "^1.7.9" }]`
   and your code.

---

## Rules for writing code (read this)

1. **Use ES Modules.** Write `import x from 'y'` and `export`. Do NOT use
   `require()`. The folder is created with `"type": "module"`.
2. **Node built-ins** do not need to be in `dependencies`. Use full specifiers:
   `node:fs`, `node:fs/promises`, `node:http`, `node:path`, `node:url`,
   `node:crypto`, `node:os`.
3. **Dependencies must be listed** in `dependencies` before you import them,
   or the install step will fail. Format:

   ```jsonc
   "dependencies": [ { "name": "lodash", "version": "^4.17.21" } ]
   ```

4. **File paths** are relative to the working folder. `hello.txt` is created in
   the working folder; the tool then returns it. To read a saved file back (or
   list a folder), use `read_text_file` with a path inside the workspace.
5. **Async code is fine.** Use `await`. Scripts run with a timeout, so avoid
   waiting on network calls that hang.
6. **In `search_npm_packages`,** never put spaces in `searchTerm`. Use `+`. The
   results include a `version` field you can use to install the right package.

---

## How to read results

- **Console output** appears under `Node.js process output:`.
- **Saved files** appear as extra content blocks:
  - Images (PNG/JPG) → `image` content (you can display them).
  - Text/JSON files → `resource` content with the file name and path.
- **Errors** start with `Error during execution:` and include the error message
  plus a small `Telemetry` block (install/run time). Re-read the message and
  fix the code.
- **`sandbox_exec`** returns the combined stdout of each command, one per line.
- **`read_text_file`** prints a `File:` / `Size:` header then the text (or a folder
  listing with `Directories:`/`Files:` groups). Use `maxBytes` to cap large files.

---

## Common mistakes to avoid

- **Using `require()` instead of `import`.** → switch to ES module syntax.
- **Importing a package you did not list** in `dependencies`. → add it first.
- **Spaces in `searchTerm`.** → replace spaces with `+`.
- **Forgetting `container_id`** when using session tools. → copy it from
  `sandbox_initialize`.
- **Starting a background server without `listenOnPort`.** → pass the port to
  `run_js`, or the script will exit immediately.
- **Leaving sessions running.** → always call `sandbox_stop({ container_id })` when you are done, otherwise the session's folder and any background server stay alive on the host.
- **`read_text_file` outside the workspace** → paths must stay inside the
  workspace; `../` escapes are rejected on purpose.

---

## Troubleshooting

- **"Error during execution: ... module not found"** → the package is missing
  from `dependencies`, or the name is wrong. Use `search_npm_packages` to find
  the correct name.
- **Install timeout** → fewer/smaller dependencies, or use a session and install
  once.
- **No files returned** → `run_js_ephemeral` copies saved files into your
  workspace and returns them to you. In a session, files live in the session
  folder (under `sessions/<session-id>/`) until you call `sandbox_stop`; read
  them with `read_text_file` before stopping.
- **`searchTerm` rejected** → it must be non-empty and contain no spaces.

---

## Quick decision table

| Your goal | Tool |
|-----------|------|
| Run a small script, get output | `run_js_ephemeral` |
| Generate / save a file or image | `run_js_ephemeral` |
| Find the right npm package (with version) | `search_npm_packages` |
| Get TypeScript types for a package | `get_dependency_types` |
| List a folder or read a saved text file | `read_text_file` |
| Read a large file, capped to N bytes | `read_text_file` (+ `maxBytes`) |
| Run several steps in one folder | `sandbox_initialize` → `run_js` / `sandbox_exec` → `sandbox_stop` |
| Start a server and test its port | `sandbox_initialize` + `run_js({ listenOnPort })` + `sandbox_exec` (curl) + `sandbox_stop` |
