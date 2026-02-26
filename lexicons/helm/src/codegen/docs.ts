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
    overview,
    outputFormat,
    serviceFromType,
    suppressPages: ["pseudo-parameters"],
    extraPages: [
      {
        slug: "getting-started",
        title: "Getting Started",
        description: "Create your first typed Helm chart in 5 minutes",
        content: `## What is the Helm lexicon?

The Helm lexicon extends chant to produce **real, parameterized Helm charts** from typed TypeScript. Unlike static manifest generators (like cdk8s's Helm output), the Helm lexicon generates:

- \`{{ .Values.x }}\` template directives
- \`values.yaml\` with typed defaults
- \`values.schema.json\` for validation
- Conditional resources via \`{{- if }}\`
- Standard \`_helpers.tpl\`
- Helm hooks and tests

## Install

\`\`\`bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-helm @intentius/chant-lexicon-k8s
\`\`\`

## Your first chart

\`\`\`bash
chant init --lexicon helm
\`\`\`

This creates a scaffold with a Chart, Values, Deployment, and Service. Run \`chant build\` to produce a complete Helm chart directory.

## Key imports

\`\`\`typescript
// Resources
import { Chart, Values, HelmNotes } from "@intentius/chant-lexicon-helm";

// Intrinsics (produce Go template expressions)
import { values, Release, include, printf, toYaml, If } from "@intentius/chant-lexicon-helm";

// K8s resources
import { Deployment, Service, Ingress } from "@intentius/chant-lexicon-k8s";
\`\`\`
`,
      },
      {
        slug: "intrinsics",
        title: "Intrinsics Reference",
        description: "All Helm template intrinsics and how they map to Go template expressions",
        content: `## Values proxy

\`\`\`typescript
import { values } from "@intentius/chant-lexicon-helm";

values.replicaCount           // {{ .Values.replicaCount }}
values.image.repository       // {{ .Values.image.repository }}
values.x.pipe("upper")        // {{ .Values.x | upper }}
\`\`\`

## Built-in objects

\`\`\`typescript
import { Release, ChartRef } from "@intentius/chant-lexicon-helm";

Release.Name         // {{ .Release.Name }}
Release.Namespace    // {{ .Release.Namespace }}
Release.IsUpgrade    // {{ .Release.IsUpgrade }}
ChartRef.Name        // {{ .Chart.Name }}
ChartRef.Version     // {{ .Chart.Version }}
\`\`\`

## Template functions

| Function | Output |
|----------|--------|
| \`include("name")\` | \`{{ include "name" . }}\` |
| \`required("msg", values.x)\` | \`{{ required "msg" .Values.x }}\` |
| \`helmDefault("val", values.x)\` | \`{{ default "val" .Values.x }}\` |
| \`toYaml(values.x)\` | \`{{ toYaml .Values.x }}\` |
| \`toYaml(values.x, 12)\` | \`{{ toYaml .Values.x \\| nindent 12 }}\` |
| \`quote(values.x)\` | \`{{ .Values.x \\| quote }}\` |
| \`printf("%s:%s", a, b)\` | \`{{ printf "%s:%s" a b }}\` |
| \`tpl(values.x)\` | \`{{ tpl .Values.x . }}\` |
| \`lookup("v1", "Secret", "ns", "name")\` | \`{{ lookup "v1" "Secret" "ns" "name" }}\` |

## Control flow

\`\`\`typescript
import { If, Range, With, values } from "@intentius/chant-lexicon-helm";

// Conditional resource
export const ingress = If(values.ingress.enabled, new Ingress({ ... }));

// Conditional value
const image = If(values.image.tag, printf("%s:%s", values.image.repo, values.image.tag));
\`\`\`
`,
      },
      {
        slug: "composites",
        title: "Composites",
        description: "Pre-built Helm chart patterns",
        content: `## Available composites

| Composite | Description | Resources |
|-----------|-------------|-----------|
| \`HelmWebApp\` | Web application | Deployment, Service, Ingress?, HPA?, ServiceAccount? |
| \`HelmStatefulService\` | Stateful workload | StatefulSet, headless Service, PVC |
| \`HelmCronJob\` | Scheduled job | CronJob |
| \`HelmMicroservice\` | Full microservice | Deployment, Service, Ingress?, HPA?, PDB?, ServiceAccount, ConfigMap? |
| \`HelmLibrary\` | Library chart | Chart.yaml (type: library), _helpers.tpl |

## Example

\`\`\`typescript
import { HelmWebApp } from "@intentius/chant-lexicon-helm";

const result = HelmWebApp({
  name: "my-app",
  imageRepository: "myregistry/app",
  port: 3000,
  replicas: 3,
  ingress: true,
  autoscaling: true,
});

// result.chart, result.values, result.deployment, result.service, result.ingress, result.hpa
\`\`\`
`,
      },
      {
        slug: "rules",
        title: "Lint Rules",
        description: "Pre-synth and post-synth lint rules for Helm charts",
        content: `## Pre-synth rules (AST-level)

| Rule | Severity | Description |
|------|----------|-------------|
| WHM001 | error | Chart must have name, version, and apiVersion |
| WHM002 | warning | Values should not contain bare secrets (password, token, key) |
| WHM003 | warning | Container images should use values references, not hardcoded tags |

## Post-synth checks (output validation)

| Check | Severity | Description |
|-------|----------|-------------|
| WHM101 | error | Chart.yaml has required fields and apiVersion v2 |
| WHM102 | warning | values.schema.json present when Values type used |
| WHM103 | error | Go template syntax valid (balanced braces) |
| WHM104 | info | NOTES.txt exists for application charts |
| WHM105 | warning | _helpers.tpl exists |
| WHM201 | info | Resources have standard Helm labels |
| WHM202 | info | Hook weights defined for multi-hook charts |
| WHM203 | info | Values entries documented |
| WHM204 | warning | Dependencies use semver ranges |
| WHM301 | info | At least one test for application charts |
| WHM302 | info | Resource limits set (via values or defaults) |
`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the Helm lexicon",
        content: `## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically — giving it operational knowledge about the Helm chart workflow.

## Bundled skill: chant-helm

The \`chant-helm\` skill teaches AI agents how to:

- Scaffold new Helm chart projects with \`chant init --lexicon helm\`
- Use Helm intrinsics (values proxy, include, printf, toYaml, If/Range/With)
- Build and validate charts with chant + helm CLI
- Debug common issues (unbalanced braces, hardcoded images, missing metadata)
- Use composites for common patterns (WebApp, Microservice, StatefulService)

When you scaffold a new project with \`chant init --lexicon helm\`, the skill is installed to \`.claude/skills/chant-helm/SKILL.md\` for automatic discovery by Claude Code.
`,
      },
    ],
  };

  const result = await docsPipeline(config);
  writeDocsSite(result, config.outDir);

  if (opts?.verbose) {
    console.error(`Generated ${result.pages.length} documentation pages`);
  }
}
