/**
 * GCP Config Connector documentation generator.
 *
 * Produces a standalone Starlight docs site at lexicons/gcp/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Extract service name from GCP resource type: "GCP::Compute::Instance" → "Compute"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Other";
}

const overview = `The **GCP Config Connector** lexicon provides full support for defining Google Cloud infrastructure using chant's declarative TypeScript syntax. Resources are serialized to Config Connector YAML manifests.

This lexicon is generated from the official [Config Connector CRDs](https://github.com/GoogleCloudPlatform/k8s-config-connector) and includes coverage for 300+ resource types across 80+ GCP services.

New? Start with the [Getting Started](/chant/lexicons/gcp/getting-started/) guide.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-gcp
\`\`\`

## Quick Start

\`\`\`typescript
import { StorageBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const bucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});
\`\`\`

The lexicon provides **300+ resource types** across Compute, Storage, IAM, Networking, Container, SQL, PubSub, and more, plus composites (GkeCluster, CloudRunService, CloudSqlInstance, GcsBucket, VpcNetwork, PubSubPipeline, CloudFunctionWithTrigger, PrivateService, ManagedCertificate, SecureProject) for common patterns.
`;

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

## Key conversions

| Chant (TypeScript) | YAML output | Rule |
|--------------------|-------------|------|
| \`export const myBucket = new StorageBucket({...})\` | \`metadata.name: my-bucket\` | Export name → kebab-case |
| \`defaultLabels({...})\` | Merged into all resources | Project-wide label injection |
| \`defaultAnnotations({...})\` | Merged into all resources | Project-wide annotation injection |

## Applying

Apply to a Kubernetes cluster with Config Connector installed:

\`\`\`bash
# Dry run
kubectl apply -f dist/manifests.yaml --dry-run=server

# Apply
kubectl apply -f dist/manifests.yaml
\`\`\`

## Compatibility

The output is compatible with:
- kubectl apply/diff
- Config Connector controller on GKE
- ArgoCD / Flux GitOps controllers
- Kustomize (as a base)`;

/**
 * Generate documentation for the GCP Config Connector lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "gcp",
    displayName: "GCP Config Connector",
    description: "Typed constructors for GCP Config Connector resource manifests",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    srcDir: join(pkgDir, "src"),
    basePath: "/chant/lexicons/gcp/",
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
