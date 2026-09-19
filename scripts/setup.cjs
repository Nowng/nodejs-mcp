#!/usr/bin/env node
/**
 * setup.cjs
 * ---------
 * Post-install / build entry point for the nodejs-mcp LM Studio Plugin.
 *
 * Responsibilities:
 *   1. Ensure the pristine upstream repo `node-code-sandbox-mcp` is present.
 *      It is cloned from GitHub with `git clone --depth 1`. We NEVER modify it,
 *      so it can keep being updated via `git pull` in its own worktree.
 *   2. Build the upstream TypeScript sources into `node-code-sandbox-mcp/dist/`
 *      using THIS plugin's hoisted TypeScript (so we do not depend on the
 *      upstream repo's own dev toolchain being installed).
 *
 * The whole script is defensive: it logs clearly and never throws, so a Hub
 * install (`npm install` -> postinstall) always succeeds even if network or
 * git is unavailable. The plugin entry point reports a friendly error at load
 * time when the upstream build is missing.
 *
 * Usage:
 *   node scripts/setup.cjs            # ensure clone + build (default)
 *   node scripts/setup.cjs --clean    # remove the cloned upstream tree only
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname, '..');
const UPSTREAM_DIR = path.join(PROJECT_ROOT, 'node-code-sandbox-mcp');
// A docker-free helper module we always emit. (dist/server.js is intentionally
// NOT produced because this plugin does not host the standalone MCP server.)
const UPSTREAM_DIST_READY = path.join(UPSTREAM_DIR, 'dist', 'config.js');
// Curated build config (declared in this plugin) that compiles ONLY the
// docker-free upstream modules we reuse. We deliberately avoid building the
// full upstream tree because that would require the archived `npm-registry-sdk`
// package and the entire ESLint toolchain, neither of which the plugin needs.
const UPSTREAM_TSCONIG = path.join(PROJECT_ROOT, 'tsconfig.upstream.json');
const GIT_URL =
  'https://github.com/alfonsograziano/node-code-sandbox-mcp.git';

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[setup]', ...args);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Returns true if `dir` looks like an existing git worktree. */
function isGitWorktree(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

function ensureCloned() {
  const needsClone = !fs.existsSync(UPSTREAM_DIR) || !isGitWorktree(UPSTREAM_DIR);

  if (!needsClone) {
    log('Upstream repo already present at', UPSTREAM_DIR);
    return;
  }

  // Clean any partial/empty directory first.
  if (fs.existsSync(UPSTREAM_DIR)) {
    fs.rmSync(UPSTREAM_DIR, { recursive: true, force: true });
  }

  log('Cloning upstream (shallow) from GitHub ...');
  execFileSync(
    'git',
    ['clone', '--depth', '1', GIT_URL, UPSTREAM_DIR],
    { stdio: 'inherit' }
  );
  log('Upstream clone complete.');
}

// ---------------------------------------------------------------------------
// Build helpers (uses the plugin's hoisted tsc)
// ---------------------------------------------------------------------------

function hoistedTscBin() {
  const candidates = [
    path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsc'),
    path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function buildUpstream() {
  if (!fs.existsSync(UPSTREAM_TSCONIG)) {
    log('Warning: tsconfig.upstream.json not found; skipping build.');
    return false;
  }

  const tsc = hoistedTscBin();
  if (!tsc) {
    log('Warning: local TypeScript not found; cannot build upstream. Run `npm install` first.');
    return false;
  }

  log('Removing any existing upstream dist ...');
  fs.rmSync(path.join(UPSTREAM_DIR, 'dist'), { recursive: true, force: true });

  log('Building the docker-free upstream subset with local tsc ...');
  execFileSync(
    tsc,
    ['-p', UPSTREAM_TSCONIG, '--declaration'],
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );

  const ok = fs.existsSync(UPSTREAM_DIST_READY);
  if (ok) {
    log('Upstream subset build complete -> dist/');
  } else {
    log('Warning: upstream build finished but expected module is missing.');
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Clean (used by `npm run clean:upstream`)
// ---------------------------------------------------------------------------

function clean() {
  log('Removing cloned upstream tree ...');
  if (fs.existsSync(UPSTREAM_DIR)) {
    fs.rmSync(UPSTREAM_DIR, { recursive: true, force: true });
    log('Removed.', UPSTREAM_DIR);
  } else {
    log('Nothing to clean.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--clean')) {
    clean();
    return;
  }

  // Skip heavy work when already set up.
  const ready =
    fs.existsSync(UPSTREAM_DIST_READY) &&
    fs.statSync(UPSTREAM_DIST_READY).size > 0;

  if (!ready) {
    ensureCloned();
    buildUpstream();
  } else {
    log('Upstream already built; skipping clone/build.');
  }
}

try {
  main();
} catch (err) {
  // Never fail `npm install` because of setup. Log and keep going.
  log('ERROR during setup:', err && err.message ? err.message : err);
  process.exitCode = 1;
}
