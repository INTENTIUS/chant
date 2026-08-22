/**
 * Documentation generation for the Kubernetes lexicon.
 *
 * Generates Starlight MDX pages for K8s entities using the core docs pipeline.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Extract service name from K8s type: "K8s::Apps::Deployment" → "Apps"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Core";
}

const overview = `The **Kubernetes** lexicon provides typed constructors for Kubernetes resource
manifests. It covers Deployments, Services, ConfigMaps, StatefulSets, Jobs,
Ingress, RBAC, and 147 resources and 50 property types.

New? Start with the [Getting Started](/chant/lexicons/k8s/getting-started/) guide.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-k8s
\`\`\`

## Quick Start

\`\`\`typescript
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

export const deployment = new Deployment({
  metadata: { name: "my-app", labels: { "app.kubernetes.io/name": "my-app" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-app" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "my-app" } },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "my-app:1.0",
            ports: [{ containerPort: 8080, name: "http" }],
            livenessProbe: new Probe({ httpGet: { path: "/healthz", port: 8080 } }),
            readinessProbe: new Probe({ httpGet: { path: "/readyz", port: 8080 } }),
          }),
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: { name: "my-app" },
  spec: {
    selector: { "app.kubernetes.io/name": "my-app" },
    ports: [{ port: 80, targetPort: 8080, name: "http" }],
  },
});
\`\`\`

The lexicon provides **147 resource types** (Deployment, Service, ConfigMap, StatefulSet, and more), **50 property types** (Container, Probe, Volume, SecurityContext, etc.), and composites (WebApp, StatefulApp, CronWorkload, AutoscaledService, WorkerPool, NamespaceEnv, NodeAgent) for common patterns.
`;

const outputFormat = `The Kubernetes lexicon serializes resources into **multi-document YAML** with
\`---\` separators between resources. Each resource gets the standard K8s
structure: \`apiVersion\`, \`kind\`, \`metadata\`, and \`spec\`.

## Building

Run \`chant build\` to produce Kubernetes manifests from your declarations:

\`\`\`bash
chant build src/ --output dist/manifests.yaml
# Writes dist/manifests.yaml
\`\`\`

The generated file includes:

- Multi-document YAML with \`---\` separators
- Correct \`apiVersion\` and \`kind\` for each resource
- \`metadata.name\` auto-generated from export names (camelCase → kebab-case)
- Default labels and annotations injected from \`defaultLabels()\`/\`defaultAnnotations()\`

## Key conversions

| Chant (TypeScript) | YAML output | Rule |
|--------------------|-------------|------|
| \`export const myApp = new Deployment({...})\` | \`metadata.name: my-app\` | Export name → kebab-case |
| \`new Container({...})\` | Inline container spec | Property types expanded inline |
| \`defaultLabels({...})\` | Merged into all resources | Project-wide label injection |

## Applying

The output is standard Kubernetes YAML. Apply with kubectl:

\`\`\`bash
# Dry run first
kubectl apply -f dist/manifests.yaml --dry-run=server

# Apply
kubectl apply -f dist/manifests.yaml

# Diff before applying
kubectl diff -f dist/manifests.yaml
\`\`\`

## Compatibility

The output is compatible with:
- kubectl apply/diff
- Helm (as raw manifests)
- ArgoCD / Flux GitOps controllers
- Kustomize (as a base)
- Any tool that processes Kubernetes YAML`;

/**
 * Generate documentation for the Kubernetes lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "k8s",
    displayName: "Kubernetes",
    description: "Typed constructors for Kubernetes resource manifests",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["pseudo-parameters"],
    basePath: "/chant/lexicons/k8s/",
  };

  const result = await docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
