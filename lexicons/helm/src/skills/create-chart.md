---
skill: chant-helm
description: Build, validate, and deploy Helm charts from a chant project
user-invocable: true
---

# Helm Chart Operational Playbook

## How chant and Helm relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into a complete Helm chart directory (Chart.yaml, values.yaml, templates/, etc.). chant does NOT call Helm CLI. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local chart comparison)
- Use **helm** for: install, upgrade, rollback, test, dependency update

The source of truth is the TypeScript in `src/`. The generated chart directory is an intermediate artifact — never edit it by hand.

## Scaffolding a new project

### Initialize with a template

```bash
chant init --lexicon helm                          # default: Deployment + Service chart
```

### Project structure after init

```
my-chart/
  src/
    chart.ts      ← Chart metadata, Values, K8s resources with Helm intrinsics
  chant.json      ← project configuration
  package.json
```

## Key concepts

### Values proxy

The `values` proxy creates `{{ .Values.x }}` template directives:

```typescript
import { values } from "@intentius/chant-lexicon-helm";

// values.replicaCount → {{ .Values.replicaCount }}
// values.image.repository → {{ .Values.image.repository }}
```

### Template functions

```typescript
import { include, printf, toYaml, quote, required, helmDefault } from "@intentius/chant-lexicon-helm";

include("my-app.fullname")           // {{ include "my-app.fullname" . }}
printf("%s:%s", values.image.repo, values.image.tag)  // {{ printf "%s:%s" ... }}
toYaml(values.resources, 12)         // {{ toYaml .Values.resources | nindent 12 }}
```

### Conditional resources

```typescript
import { If, values } from "@intentius/chant-lexicon-helm";

// Wrap an entire resource in {{- if .Values.ingress.enabled }}
export const ingress = If(values.ingress.enabled, new Ingress({ ... }));
```

### Built-in objects

```typescript
import { Release, ChartRef } from "@intentius/chant-lexicon-helm";

Release.Name       // {{ .Release.Name }}
Release.Namespace  // {{ .Release.Namespace }}
ChartRef.Version   // {{ .Chart.Version }}
```

## Build and validate workflow

```bash
# Build the chart
chant build

# Lint the TypeScript (pre-synth rules)
chant lint

# Validate the generated chart (post-synth checks)
chant check

# Validate with helm CLI
helm lint dist/
helm template test dist/
```

## Common patterns

### Deployment with parameterized image

```typescript
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
          resources: toYaml(values.resources),
        }],
      },
    },
  },
});
```

### Composites for common patterns

```typescript
import { HelmWebApp } from "@intentius/chant-lexicon-helm";
import { HelmMicroservice } from "@intentius/chant-lexicon-helm";

// Quick scaffold: Deployment + Service + Ingress + HPA + ServiceAccount
const result = HelmWebApp({ name: "my-app", port: 3000, replicas: 3 });

// Full microservice: + PDB + ConfigMap + health probes + resource limits
const msvc = HelmMicroservice({ name: "api", port: 8080 });
```

## Lint rules

| Rule | Description |
|------|-------------|
| WHM001 | Chart must have name, version, apiVersion |
| WHM002 | Values should not contain bare secrets |
| WHM003 | Container images should use values references |
| WHM101 | Chart.yaml has valid apiVersion (v2) |
| WHM102 | values.schema.json present when Values used |
| WHM103 | Go template syntax valid (balanced braces) |
| WHM104 | NOTES.txt exists for application charts |
| WHM105 | _helpers.tpl exists |
| WHM201 | Resources have standard Helm labels |
| WHM301 | At least one test for application charts |
| WHM302 | Resource limits set |

## Troubleshooting

### "apiVersion must be v2"
Helm 3 requires `apiVersion: v2` in Chart.yaml. Update your Chart metadata.

### "unbalanced template braces"
A Go template expression has mismatched `{{` / `}}`. Check your intrinsic usage.

### "hardcoded image tag"
Use `printf("%s:%s", values.image.repository, values.image.tag)` instead of literal strings for container images.
