/**
 * Pinned dependency versions for the Kubernetes lexicon.
 *
 * Centralises the schema version used by fetch.ts and provides
 * a helper to check for newer Kubernetes releases.
 */

/** Pinned versions of external dependencies. */
export const PINNED_VERSIONS = {
  k8sOpenAPI: "v1.32.0",
} as const;

/**
 * Build the raw GitHub URL for the K8s swagger.json for a given version.
 */
export function k8sSwaggerUrl(version?: string): string {
  const v = version ?? PINNED_VERSIONS.k8sOpenAPI;
  return `https://raw.githubusercontent.com/kubernetes/kubernetes/${v}/api/openapi-spec/swagger.json`;
}

/**
 * Check for a newer stable Kubernetes release on GitHub.
 * Returns the latest tag if newer than pinned, or null if up-to-date.
 */
export async function checkForUpdates(): Promise<string | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/kubernetes/kubernetes/releases/latest",
      {
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { tag_name?: string };
    const latest = data.tag_name;
    if (!latest) return null;

    return latest !== PINNED_VERSIONS.k8sOpenAPI ? latest : null;
  } catch {
    return null;
  }
}
