/**
 * Pinned dependency versions for reproducible generation.
 */

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
    const resp = await fetch("https://api.github.com/repos/aws-cloudformation/cfn-lint/releases/latest", {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (resp.ok) {
      const data = await resp.json() as { tag_name: string };
      latest = data.tag_name;
    }
  } catch {
    // Network failure — return current as latest
  }

  return { cfnLint: { current, latest } };
}
