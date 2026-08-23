/**
 * Documentation generation for the k3s lexicon.
 *
 * Generates Starlight MDX pages for k3s entities using the core docs pipeline.
 * The overview prose lives here; authored pages live under docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "K3s";
}

const overview = `The k3s lexicon declares the files k3s itself consumes: \`config.yaml\` for
\`k3s server\` / \`k3s agent\`, and \`registries.yaml\` for the embedded
containerd. The emitted files are exactly what the native tool accepts —
drop them at \`/etc/rancher/k3s/\` (or pass \`--config\`) and chant is nowhere
in sight. That walk-away property is the reason this is a lexicon at all.

\`\`\`bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-k3s
\`\`\`

\`\`\`typescript
// chant.config.ts
export default {
  lexicons: ["k3s"],
};
\`\`\`

## A two-node cluster

\`\`\`typescript
import { Agent, Server } from "@intentius/chant-lexicon-k3s";

export const controlPlane = new Server({
  "cluster-init": true,
  "tls-san": ["10.0.0.10", "cp.example.internal"],
  "write-kubeconfig-mode": "0600",
});

export const worker = new Agent({
  server: "https://cp.example.internal:6443",
  "token-file": "/etc/rancher/k3s/agent-token",
});
\`\`\`

## The token boundary

There is no \`token\` property, on purpose. The join secret reaches a node
as a file (\`token-file\`, \`agent-token-file\`) or as \`K3S_TOKEN\` /
\`K3S_TOKEN_FILE\` in the installer's environment — never as a value in
source. A literal that arrives through raw props anyway fails K3S001 at
lint and K3S101 at build; the same wall covers the etcd S3 snapshot
credentials (\`etcd-s3-config-secret\` is the reference form upstream
provides).

## Relationship to k3d

The [k3d lexicon](/chant/lexicons/k3d/) declares a k3d-managed cluster —
k3s wrapped in Docker, config consumed by the \`k3d\` CLI. This lexicon
declares k3s on real hosts: Lima VMs, bare metal, cloud instances. The
acceptance test for both is the same idea — the native tool consuming the
emitted file is the proof.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "k3s",
    displayName: "K3s",
    description: "k3s host configuration (server/agent config.yaml and registries.yaml) as typed chant source",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/k3s/",
    overview,
    serviceFromType,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
