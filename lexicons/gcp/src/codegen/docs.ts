/**
 * GCP Config Connector documentation generator.
 *
 * Produces a standalone Starlight docs site at lexicons/gcp/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(__dirname_, "..", "..");

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Other";
}

const overview = `The **GCP Config Connector** lexicon provides full support for defining Google Cloud infrastructure using chant's declarative TypeScript syntax. Resources are serialized to Config Connector YAML manifests.

This lexicon is generated from the official [Config Connector CRDs](https://github.com/GoogleCloudPlatform/k8s-config-connector) and includes coverage for 300+ resource types across 80+ GCP services.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-gcp
\`\`\``;

const outputFormat = `The GCP lexicon serializes resources into **Config Connector YAML manifests** (Kubernetes CRDs).

## Building

Run \`chant build\` to produce Config Connector YAML from your declarations:

\`\`\`bash
chant build
# Writes dist/manifests.yaml
\`\`\`

The generated manifests include:

- \`apiVersion\` and \`kind\` (Config Connector CRD)
- \`metadata\` with name, labels, and annotations
- \`spec\` with the resource configuration

## Applying

Apply to a Kubernetes cluster with Config Connector installed:

\`\`\`bash
kubectl apply -f dist/manifests.yaml
\`\`\``;

const docsConfig: DocsConfig = {
  lexiconName: "gcp",
  lexiconDisplayName: "GCP Config Connector",
  overview,
  outputFormat,
  serviceFromType,
  registryFilename: "lexicon-gcp.json",
  srcDir: pkgDir,
  outputDir: join(pkgDir, "docs"),
  resourceTypeUrl: (resourceType: string) => {
    // Link to Config Connector docs
    const parts = resourceType.split("::");
    if (parts.length >= 3) {
      const service = parts[1].toLowerCase();
      const kind = parts[2].toLowerCase();
      return `https://cloud.google.com/config-connector/docs/reference/resource-docs/${service}/${service}${kind}`;
    }
    return undefined;
  },
};

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const result = await docsPipeline(docsConfig, opts);
  writeDocsSite(result, docsConfig.outputDir);
}
