/**
 * Vendored snapshot of tools already present on GitHub-hosted runner images,
 * used by GHA056 to flag redundant runtime installs that add third-party
 * surface for no benefit.
 *
 * Advisory. Refresh source: the runner-images repository's installed-software
 * manifests. Conservative on purpose — only tools that are reliably present
 * across the common ubuntu/macos/windows images are listed.
 */
export const PREINSTALLED_TOOLS: readonly string[] = [
  "git",
  "curl",
  "wget",
  "jq",
  "make",
  "gcc",
  "g++",
  "zip",
  "unzip",
  "tar",
  "docker",
  "docker-compose",
  "python3",
  "pip3",
  "node",
  "npm",
  "yarn",
  "go",
  "gh",
  "aws",
  "az",
  "gcloud",
  "kubectl",
  "helm",
  "terraform",
];
