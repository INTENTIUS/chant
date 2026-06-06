/**
 * Pinned dependency versions for reproducible generation.
 */

import { fetchWithRetry } from "@intentius/chant/codegen/fetch";

export const PINNED_VERSIONS = {
  cfnLint: "v1.32.4",
} as const;

/**
 * Build the cfn-lint tarball URL for a given version tag.
 */
export function cfnLintTarballUrl(version?: string): string {
  const tag = version ?? PINNED_VERSIONS.cfnLint;
  return `https://github.com/aws-cloudformation/cfn-lint/archive/refs/tags/${tag}.tar.gz`;
}

/**
 * Check for newer versions of pinned dependencies.
 */
export async function checkForUpdates(): Promise<{ cfnLint: { current: string; latest: string } }> {
  const current = PINNED_VERSIONS.cfnLint;
  let latest: string = current;

  try {
    const resp = await fetchWithRetry(
      "https://api.github.com/repos/aws-cloudformation/cfn-lint/releases/latest",
      undefined,
      undefined,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    const data = await resp.json() as { tag_name: string };
    latest = data.tag_name;
  } catch {
    // Transient failures are retried inside fetchWithRetry; a permanent
    // failure (or exhausted retries) lands here — return current as latest.
  }

  return { cfnLint: { current, latest } };
}
