/**
 * Documentation generation for the k3d lexicon.
 *
 * Generates Starlight MDX pages for k3d entities using the core docs pipeline.
 * The overview prose lives here; authored pages live under docs/pages/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "K3d";
}

const overview = `The k3d lexicon types [k3d](https://k3d.io)'s own declarative config —
\`k3d.io/v1alpha5\` SimpleConfig, generated from upstream's published JSON
Schema, pinned at **k3d v5.9.0**. \`chant build\` emits a YAML file that
\`k3d cluster create --config\` consumes verbatim, so the walk-away cost is
zero: the artifact is a file the native tool accepts with chant nowhere in
sight.

\`\`\`ts
import { Cluster, K3dOptions, Options } from "@intentius/chant-lexicon-k3d";

export const devCluster = new Cluster({
  metadata: { name: "chant-dev" },
  servers: 1,
  agents: 0,
  options: new Options({
    k3d: new K3dOptions({ disableLoadbalancer: true }),
  }),
});
\`\`\`

## The kubeconfig default is chant's, not upstream's

k3d's own defaults rewrite \`~/.kube/config\` and switch your active context
on every cluster create. When a declaration says nothing about
\`options.kubeconfig\`, the emitted config pins both off:

\`\`\`yaml
options:
  kubeconfig:
    updateDefaultKubeconfig: false
    switchCurrentContext: false
\`\`\`

This is deliberate: a tool that reconciles infrastructure must not repoint
your shell as a side effect — an unrelated \`k3d cluster create\` switching
the ambient context mid-run produces convincingly false failures. Declare
\`options.kubeconfig\` yourself to opt back into upstream behaviour; what you
write is emitted exactly as written. The \`k3dUp\` activity reports the
context name and kubeconfig path it produced either way, so whatever
applies manifests afterwards knows what to talk to.

## Lifecycle is an Op activity pair

Cluster creation is procedural, not desired-state — nobody expects
\`chant lifecycle diff\` to reconcile a laptop. \`k3dUp\` / \`k3dDown\` shell out
to k3d with the emitted config and are idempotent; add \`"k3d"\` to your
project's \`lexicons\` so \`loadActivities\` finds them.

## Ownership and observation

With ownership configured, the serializer stamps chant's marker as Docker
labels on every node via \`options.runtime.labels\`; the labels survive
\`k3d cluster stop\`/\`start\`. \`chant lifecycle diff --live\` reports each
declared cluster as present, absent, or not-observed-with-a-reason — Docker
being down reads as *not observed*, never as *absent*, so a stopped daemon
cannot masquerade as a missing cluster. There is no property-level drift on
purpose: the config is an input to creation, not a spec k3d reconciles
against.

## Checks

- **K3D001** (lint, error) — a literal \`registries.create.proxy.password\`
  in source. A committed cluster config is a leaked registry credential.
- **K3D101** (post-synth, error) — a \`nodeFilter\` that matches no node.
  k3d applies an unmatched filter to nothing and says nothing.
- **K3D102** (post-synth, error) — a registry proxy password that reached
  the emitted config, whatever route it took through the source.
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "k3d",
    displayName: "K3d",
    description: "Declare a local k3d cluster as data; the config is the artifact",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/k3d/",
    overview,
    serviceFromType,
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
