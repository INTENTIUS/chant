/**
 * Vendored snapshot of widely-used GitHub Action `owner/repo` slugs.
 *
 * Used by the look-alike check (GHA031) as the reference set: a `uses:` slug
 * that is a near-miss (edit distance 1–2) of one of these — but not an exact
 * match — is likely a typo or an impersonation of the popular action.
 *
 * Advisory only. Refresh source: the GitHub Marketplace "most-used" actions and
 * the actions/* org. Accept staleness — regenerate periodically by editing this
 * list; a stale entry only weakens look-alike detection, it never blocks a build.
 */
export const KNOWN_ACTION_SLUGS: readonly string[] = [
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-go",
  "actions/setup-java",
  "actions/setup-dotnet",
  "actions/cache",
  "actions/upload-artifact",
  "actions/download-artifact",
  "actions/github-script",
  "actions/stale",
  "actions/labeler",
  "actions/dependency-review-action",
  "docker/build-push-action",
  "docker/login-action",
  "docker/setup-buildx-action",
  "docker/setup-qemu-action",
  "docker/metadata-action",
  "aws-actions/configure-aws-credentials",
  "azure/login",
  "google-github-actions/auth",
  "hashicorp/setup-terraform",
  "codecov/codecov-action",
  "softprops/action-gh-release",
  "peter-evans/create-pull-request",
];
