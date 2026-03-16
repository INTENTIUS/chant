---
skill: chant-helm-patterns
description: Common Helm chart patterns and best practices using chant
user-invocable: true
---

# Common Helm Chart Patterns

## Standard Chart Layout

A chant Helm project compiles TypeScript into the standard Helm directory structure:

```
my-chart/
  Chart.yaml          ← chart metadata (name, version, apiVersion: v2)
  values.yaml         ← default configuration values
  templates/
    deployment.yaml
    service.yaml
    ingress.yaml
    _helpers.tpl      ← named templates (fullname, labels, etc.)
    NOTES.txt         ← post-install instructions
  charts/             ← subcharts (dependencies)
```

The source of truth is `src/`. Never edit generated files in `templates/` by hand.

## Parameterization via Values Proxy

The `values` proxy turns property access into `{{ .Values.x }}` template directives:

```typescript
import { values } from "@intentius/chant-lexicon-helm";

// Simple access
values.replicaCount          // → {{ .Values.replicaCount }}

// Nested access
values.image.repository      // → {{ .Values.image.repository }}
values.image.tag             // → {{ .Values.image.tag }}

// Use in resource definitions
export const deployment = new Deployment({
  spec: {
    replicas: values.replicaCount,
    template: {
      spec: {
        containers: [{
          name: "app",
          image: printf("%s:%s", values.image.repository, values.image.tag),
        }],
      },
    },
  },
});
```

Default values are set in the `Values` resource, which becomes `values.yaml`.

## Conditional Resources with If()

Wrap resources in `If()` to gate them on a values flag:

```typescript
import { If, values } from "@intentius/chant-lexicon-helm";
import { Ingress } from "@intentius/chant-lexicon-k8s";

// Only rendered when .Values.ingress.enabled is true
export const ingress = If(values.ingress.enabled, new Ingress({
  metadata: { name: include("my-app.fullname") },
  spec: {
    rules: [{ host: values.ingress.hostname }],
  },
}));
```

`If()` wraps the entire template output in `{{- if .Values.ingress.enabled }}...{{- end }}`.

## Helper Templates with include()

Reference named templates from `_helpers.tpl`:

```typescript
import { include } from "@intentius/chant-lexicon-helm";

export const deployment = new Deployment({
  metadata: {
    name: include("my-app.fullname"),
    labels: include("my-app.labels"),
  },
  spec: {
    selector: {
      matchLabels: include("my-app.selectorLabels"),
    },
  },
});
```

The composites (`HelmWebApp`, `HelmMicroservice`, etc.) generate `_helpers.tpl` automatically with standard named templates for fullname, labels, and selector labels.

## Dependency Management with HelmDependency

Declare subchart dependencies that go into `Chart.yaml`:

```typescript
import { HelmDependency } from "@intentius/chant-lexicon-helm";

export const redisDep = HelmDependency({
  name: "redis",
  version: "17.x",
  repository: "https://charts.bitnami.com/bitnami",
  condition: "redis.enabled",
});

export const postgresqlDep = HelmDependency({
  name: "postgresql",
  version: "12.x",
  repository: "https://charts.bitnami.com/bitnami",
  condition: "postgresql.enabled",
});
```

After building, run `helm dependency update` to fetch the subcharts.

## Multi-Environment Configuration

Use separate values files per environment and compose them at deploy time:

```typescript
// src/infra.ts — base chart with parameterized defaults
export const app = HelmWebApp({
  name: "my-app",
  port: 3000,
  replicas: 1,              // default for dev
  imageTag: "latest",       // overridden per env
});
```

```bash
# Deploy with environment-specific overrides
helm install my-app . -f values.yaml -f values-staging.yaml
helm install my-app . -f values.yaml -f values-production.yaml
```

Structure values files as overlays: `values.yaml` (defaults) -> `values-staging.yaml` (overrides) -> `values-production.yaml` (overrides). Later files win.

## Library Charts with HelmLibrary

Create reusable chart libraries that other charts can import:

```typescript
import { HelmLibrary } from "@intentius/chant-lexicon-helm";

export const library = HelmLibrary({
  name: "common-templates",
  version: "1.0.0",
  templates: {
    "common.labels": labelsTemplate,
    "common.annotations": annotationsTemplate,
    "common.fullname": fullnameTemplate,
  },
});
```

Library charts produce no templates of their own. They are included as dependencies by application charts, which use `include()` to reference the shared named templates.

## Testing Patterns with HelmTest

Add Helm test pods that run on `helm test`:

```typescript
import { HelmTest } from "@intentius/chant-lexicon-helm";

export const connectivityTest = HelmTest({
  name: "test-connection",
  image: "busybox:1.36",
  command: ["wget", "--spider", "http://my-app:3000/healthz"],
});
```

This generates a pod in `templates/tests/` with the `helm.sh/hook: test` annotation. Run tests after install:

```bash
helm install my-app .
helm test my-app
```

**Lint rule WHM301** fires when an application chart has no test resources.

## Composites Quick Reference

| Composite           | Resources created                                           |
|---------------------|-------------------------------------------------------------|
| `HelmWebApp`        | Chart, Values, Deployment, Service, Ingress?, HPA?, SA?     |
| `HelmMicroservice`  | Chart, Values, Deployment, Service, SA, ConfigMap?, PDB?, HPA?, Ingress? |
| `HelmWorker`        | Chart, Values, Deployment, SA, HPA?, PDB?                   |
| `HelmCronJob`       | Chart, Values, CronJob                                      |
| `HelmStatefulSet`   | Chart, Values, StatefulSet, Service                          |
| `HelmDaemonSet`     | Chart, Values, DaemonSet, SA?                                |
| `HelmLibrary`       | Chart (type: library), named templates                       |

All composites accept optional `podSecurityContext`, `securityContext`, `nodeSelector`, `tolerations`, `affinity`, and `strategy` fields.

## Built-in Objects

Access Helm's built-in objects in templates:

```typescript
import { Release, ChartRef, Capabilities } from "@intentius/chant-lexicon-helm";

Release.Name          // {{ .Release.Name }}
Release.Namespace     // {{ .Release.Namespace }}
Release.IsUpgrade     // {{ .Release.IsUpgrade }}
ChartRef.Name         // {{ .Chart.Name }}
ChartRef.Version      // {{ .Chart.Version }}
```

## Deploying Upstream Charts with Value Overrides

When you need to deploy an upstream chart (like `gitlab/gitlab`) with custom values, avoid wrapper charts with no templates. Instead:

1. Use `runtimeSlot()` in `new Values({...})` for deploy-time values (DB IPs, bucket names, replicas)
2. Use `ValuesOverride` for static values shared across all environments (disabled bundled services, shared secret refs)
3. Deploy the upstream chart directly with `-f` flags

```typescript
import { Values, ValuesOverride, runtimeSlot } from "@intentius/chant-lexicon-helm";

// Runtime slots → values-runtime-slots.yaml (deploy-time checklist)
export const vals = new Values({
  global: {
    psql: { host: runtimeSlot("Cloud SQL private IP") },
    redis: { host: runtimeSlot("Memorystore host") },
  },
});

// Static overrides → values-base.yaml (shared across all deployments)
export const baseOverride = new ValuesOverride({
  filename: "values-base",
  values: {
    postgresql: { install: false },
    redis: { install: false },
    certmanager: { install: false },
    "nginx-ingress": { enabled: false },
  },
});
```

Outputs:
- `chart-dir/values.yaml` — defaults; runtime slots appear as `''`
- `chart-dir/values-base.yaml` — generated static overrides
- `chart-dir/values-runtime-slots.yaml` — deploy-time slots with descriptions as comments

Deploy:
```bash
# chant build generates chart-dir/ including values-base.yaml
chant build

# Fill in runtime-slot values (one per environment)
# values-prod.yaml contains: global.psql.host, global.redis.host, etc.

helm upgrade --install my-release upstream/chart \
  -f chart-dir/values-base.yaml \
  -f values-prod.yaml \
  --wait
```

**WHM005** warns when a chart has `HelmDependency` entries but generates no templates — this is the "empty wrapper" anti-pattern that requires `helm dependency build` as a non-obvious prerequisite.

## Template Functions

```typescript
import { include, printf, toYaml, quote, required, helmDefault } from "@intentius/chant-lexicon-helm";

include("my-app.fullname")                    // {{ include "my-app.fullname" . }}
printf("%s-%s", Release.Name, "worker")       // {{ printf "%s-%s" .Release.Name "worker" }}
toYaml(values.resources, 12)                  // {{ toYaml .Values.resources | nindent 12 }}
quote(values.annotations)                     // {{ quote .Values.annotations }}
required("image.tag is required", values.image.tag)  // {{ required "..." .Values.image.tag }}
helmDefault(values.replicas, 1)               // {{ default 1 .Values.replicas }}
```
