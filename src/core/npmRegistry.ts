/**
 * npm registry helpers, reimplemented with the global `fetch`.
 *
 * The original used the `npm-registry-sdk` package, which is not part of
 * LM Studio's plugin runtime. Both endpoints are plain HTTP, so we call the
 * public npm Registry directly. Network access is required.
 */

export interface SearchResult {
  name: string;
  description: string;
  readmeSnippet: string;
}

export interface DependencyTypeInfo {
  name: string;
  hasTypes: boolean;
  version?: string;
  typesPackage?: string;
  types?: string;
}

const README_SNIPPET_MAX = 500;

function buildQualifiersString(qualifiers?: {
  author?: string;
  maintainer?: string;
  scope?: string;
  keywords?: string;
  not?: string;
  is?: string;
  boostExact?: string;
}): string | undefined {
  if (!qualifiers) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(qualifiers) as [
    keyof typeof qualifiers,
    string | undefined,
  ][]) {
    if (!value) continue;
    const field =
      key === 'boostExact' ? 'boostExactText' : key === 'is' ? 'from' : key;
    // The search API expects quoted values for most qualifiers.
    parts.push(`${field}:${JSON.stringify(value)}`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

export async function searchNpmPackages(
  params: {
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
  signal?: AbortSignal
): Promise<string> {
  const { searchTerm, qualifiers } = params;

  const query = new URLSearchParams({ text: searchTerm, limit: '5' });
  const q = buildQualifiersString(qualifiers);
  if (q) query.set('qualifiers', q);

  let res: Response;
  try {
    res = await fetch(
      `https://registry.npmjs.org/-/v1/search?${query.toString()}`,
      { signal }
    );
  } catch (err) {
    return `Failed to search npm packages for "${searchTerm}". Error: ${errMsg(err)}`;
  }

  if (!res.ok) {
    return `Failed to search npm packages: registry returned HTTP ${res.status}.`;
  }

  const data = (await res.json()) as {
    total: number;
    objects: Array<{ package: { name: string } }>;
  };

  if (!data.total || !data.objects.length) {
    return 'No packages found.';
  }

  const names = data.objects.slice(0, 5).map((o) => o.package.name);
  const infos: SearchResult[] = await Promise.all(
    names.map((name) => fetchPackageDetails(name, signal))
  );

  return JSON.stringify(infos, null, 2);
}

async function fetchPackageDetails(
  name: string,
  signal?: AbortSignal
): Promise<SearchResult> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal,
    });
    if (!res.ok) {
      return { name, description: 'No description available.', readmeSnippet: 'README not available.' };
    }
    const meta = (await res.json()) as {
      description?: string;
      readme?: string;
    };
    const readme = meta.readme ?? '';
    const snippet = readme
      .substring(0, README_SNIPPET_MAX)
      .trim() + (readme.length > README_SNIPPET_MAX ? '...' : '');
    return {
      name,
      description: meta.description || 'No description available.',
      readmeSnippet: snippet || 'README not available.',
    };
  } catch {
    return { name, description: 'No description available.', readmeSnippet: 'README not available.' };
  }
}

export async function getDependencyTypes(
  dependencies: Array<{ name: string; version?: string }>,
  signal?: AbortSignal
): Promise<string> {
  const results: DependencyTypeInfo[] = [];

  for (const dep of dependencies) {
    const info: DependencyTypeInfo = { name: dep.name, hasTypes: false };
    try {
      const pkgRes = await fetch(`https://registry.npmjs.org/${dep.name}`, {
        signal,
      });
      if (pkgRes.ok) {
        const pkgMeta = (await pkgRes.json()) as any;
        const latestTag = pkgMeta['dist-tags']?.latest as string | undefined;
        const versionToUse = dep.version ?? latestTag ?? 'latest';
        const versionData = pkgMeta.versions?.[versionToUse];
        if (versionData) {
          const typesField = versionData.types || versionData.typings;
          if (typesField) {
            const url = `https://unpkg.com/${dep.name}@${versionToUse}/${typesField}`;
            const contentRes = await fetch(url, { signal });
            if (contentRes.ok) {
              info.hasTypes = true;
              info.types = await contentRes.text();
              info.version = versionToUse;
              results.push(info);
              continue;
            }
          }
        }

        // Fallback to a matching @types/... package.
        const sanitized = dep.name.replace('@', '').replace('/', '__');
        const typesName = `@types/${sanitized}`;
        const typesRes = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(typesName)}`,
          { signal }
        );
        if (typesRes.ok) {
          const typesMeta = (await typesRes.json()) as any;
          const typesVersion = typesMeta['dist-tags']?.latest as string | undefined;
          const typesVersionData = typesMeta.versions?.[typesVersion ?? 'latest'];
          const typesField =
            typesVersionData?.types ||
            typesVersionData?.typings ||
            'index.d.ts';
          const url = `https://unpkg.com/${typesName}@${typesVersion}/${typesField}`;
          const contentRes = await fetch(url, { signal });
          if (contentRes.ok) {
            info.hasTypes = true;
            info.typesPackage = typesName;
            info.version = typesVersion;
            info.types = await contentRes.text();
          }
        }
      }
    } catch {
      /* keep hasTypes=false */
    }
    results.push(info);
  }

  return JSON.stringify(results, null, 2);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
