/**
 * Documentation generation for the Helm lexicon.
 *
 * Generates Starlight MDX pages for Helm entities using the core docs pipeline.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Helm";
}

const overview = `The **Helm** lexicon generates production-quality, parameterized Helm charts from typed TypeScript.

Unlike static manifest generators, the Helm lexicon produces real \`{{ .Values.x }}\` directives, \`values.yaml\`, \`values.schema.json\`, conditional resources, Helm hooks, and standard \`_helpers.tpl\`.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-helm @intentius/chant-lexicon-k8s
\`\`\`

## Quick Start

\`\`\`typescript
import { Chart, Values } from "@intentius/chant-lexicon-helm";
import { values, include, printf, toYaml } from "@intentius/chant-lexicon-helm";
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "my-app",
  version: "0.1.0",
  type: "application",
});

export const valuesSchema = new Values({
  replicaCount: 1,
  image: { repository: "nginx", tag: "", pullPolicy: "IfNotPresent" },
  service: { type: "ClusterIP", port: 80 },
});

export const deployment = new Deployment({
  metadata: {
    name: include("my-app.fullname"),
    labels: include("my-app.labels"),
  },
  spec: {
    replicas: values.replicaCount,
    template: {
      spec: {
        containers: [{
          name: "my-app",
          image: printf("%s:%s", values.image.repository, values.image.tag),
          ports: [{ containerPort: values.service.port, name: "http" }],
          resources: toYaml(values.resources),
        }],
      },
    },
  },
});
\`\`\`

Build the chart:

\`\`\`bash
chant build
helm lint dist/
helm template test dist/
\`\`\`
`;

const outputFormat = `## Output structure

The Helm serializer produces a complete chart directory:

\`\`\`
dist/
  Chart.yaml              ← from Chart entity
  values.yaml             ← from Values entity (defaults)
  values.schema.json      ← auto-generated JSON Schema from Values types
  .helmignore
  templates/
    _helpers.tpl          ← auto-generated standard helpers
    deployment.yaml       ← K8s resources with {{ .Values.x }} directives
    service.yaml
    NOTES.txt             ← from HelmNotes entity
    tests/
      test-connection.yaml ← from HelmTest entities
\`\`\`
`;

export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "helm",
    displayName: "Helm",
    description: "Typed constructors for parameterized Helm charts",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    basePath: process.env.DOCS_BASE_PATH ?? "/chant/lexicons/helm/",
    overview,
    outputFormat,
    serviceFromType,
    // `lint-rules` under docs/pages/ is helm's rules documentation; the
    // generated `rules` table duplicated it, and helm's own declared rules
    // page was being silently overwritten by that table (#1312).
    suppressPages: ["pseudo-parameters"],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.size} documentation pages`);
  }
}
