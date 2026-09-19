/**
 * networkTools.ts
 * ---------------
 * Docker-free, network-backed tools.
 *
 * - searchNpmPackagesLocal(): reimplementation of upstream's `search_npm_packages`
 *   against the official npm registry REST API. We deliberately do NOT reuse the
 *   upstream implementation because it depends on the archived `npm-registry-sdk`
 *   package; the public API is simpler and self-contained.
 *
 * - getDependencyTypes: re-exported from the pristine upstream repo
 *   (dist/tools/getDependencyTypes.js). It only uses global fetch, so it runs
 *   unmodified inside the plugin.
 */

import {
  textContent,
  type McpResponse,
} from '../node-code-sandbox-mcp/dist/types.js';
import getDependencyTypesDefault, { argSchema } from '../node-code-sandbox-mcp/dist/tools/getDependencyTypes.js';

const MAX_RESULTS = 5;
const README_SNIPPET_LEN = 500;

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export interface Qualifiers {
  author?: string;
  maintainer?: string;
  scope?: string;
  keywords?: string;
  not?: string;
  is?: string;
  boostExact?: string;
}

interface PackageDetails {
  name: string;
  description: string;
  readmeSnippet: string;
  /** Latest published version from the npm registry dist-tags (may be undefined). */
  version?: string;
}

export async function searchNpmPackagesLocal(params: {
  searchTerm: string;
  qualifiers?: Qualifiers;
}): Promise<McpResponse> {
  const { searchTerm, qualifiers } = params;

  // Build the registry search query. The public API supports name/description/
  // keyword text search plus an optional scope qualifier.
  let text = searchTerm;
  if (qualifiers?.scope) text = `scope:${qualifiers.scope} ${searchTerm}`;

  // Resolve the ordered list of package names to look up. When `boostExact` is
  // provided we make sure the exact-matching package is surfaced — fetching it
  // via a targeted name lookup if it was not in the initial text search — and
  // then move it to the front of the results.
  const orderedNames = await resolveOrderedNames(
    text,
    MAX_RESULTS,
    qualifiers?.boostExact,
  );

  if (orderedNames.length === 0) {
    return { content: [textContent('No packages found.')] };
  }

  const details = await Promise.all(
    orderedNames.map((name) => fetchPackageDetails(name))
  );

  const infos: PackageDetails[] = details.filter(
    (d): d is PackageDetails => d != null
  );

  if (infos.length === 0) {
    return { content: [textContent('No packages found.')], isError: true };
  }

  return { content: [textContent(JSON.stringify(infos, null, 2))] };
}

interface SearchObject {
  package: { name: string; description?: string } | null;
}

/** Run a `/-/v1/search` request and return the deduped package names. */
async function fetchSearchObjects(
  textParam: string,
  size: number,
): Promise<string[] | null> {
  const data = (await fetchJson(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(textParam)}&size=${size}`
  )) as { objects?: SearchObject[] } | null | undefined;

  if (!data || !Array.isArray(data.objects)) return null;

  const names = data.objects
    .map((o) => o?.package?.name)
    .filter((n): n is string => Boolean(n));

  // De-duplicate while preserving first-occurrence order.
  return [...new Set(names)];
}

/**
 * Reliable existence check for an exact package name.
 *
 * We deliberately do NOT use the `/-/v1/search?name:` qualifier here — it is
 * unreliable (e.g. `name:lodash` returns nothing, and version/scope characters
 * break it). The full metadata document endpoint returns HTTP 200 for a real
 * package and 404 otherwise, so we use that instead.
 */
async function packageExists(name: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      { headers: { accept: 'application/json' } }
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Move the package whose name exactly matches `key` to the front, rest stays ordered. */
function boostExactFirst(names: string[], key: string): string[] {
  const k = key.toLowerCase();
  const idx = names.findIndex((n) => n.toLowerCase() === k);
  if (idx < 0) return names;
  const [boosted] = names.splice(idx, 1);
  return [boosted, ...names];
}

/**
 * Produce the final, ordered list of package names to look up.
 *
 * Without `boostExact` this mirrors the original behaviour (a single text search).
 * With `boostExact`, if the exact package is not already in the top results we do
 * a reliable metadata-document existence check so it can be surfaced, then reorder
 * it to the front.
 */
async function resolveOrderedNames(
  text: string,
  size: number,
  boostExact?: string,
): Promise<string[]> {
  if (!boostExact) {
    return (await fetchSearchObjects(text, size)) ?? [];
  }

  const key = boostExact.trim();
  let names = (await fetchSearchObjects(text, size)) ?? [];

  // Already in the result set? Just reorder it to the front.
  if (names.some((n) => n.toLowerCase() === key.toLowerCase())) {
    return boostExactFirst(names, key);
  }

  // Not in the top results — verify the package really exists via its metadata
  // document, and if so prepend it so it is surfaced and ranked first regardless
  // of what the initial text search returned.
  if (await packageExists(key)) {
    const ordered: string[] = [key];
    for (const n of names) {
      if (n !== key) ordered.push(n);
    }
    return ordered;
  }

  // No exact match anywhere — keep the original text-search order.
  return names;
}

async function fetchPackageDetails(name: string): Promise<PackageDetails | null> {
  // The lightweight `/-/v1/package/<name>` endpoint omits description/readme, so
  // use the full package metadata document instead.
  const data = (await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`
  )) as
    | {
        name?: string;
        description?: string;
        readme?: string;
        'dist-tags'?: Record<string, string>;
      }
    | undefined
    | null;

  if (!data) return null;
  const description = typeof data.description === 'string' ? data.description : '';
  const readme = typeof data.readme === 'string' ? data.readme : '';
  const snippet = readme.length > README_SNIPPET_LEN
    ? readme.slice(0, README_SNIPPET_LEN) + '...'
    : readme || 'README not available.';

  return {
    name,
    description: description || 'No description available.',
    readmeSnippet: snippet,
    version: data['dist-tags']?.latest,
  };
}

/** Re-export upstream's dependency-type lookup tool (pure network fetch). */
export const getDependencyTypes = getDependencyTypesDefault;
export { argSchema };
