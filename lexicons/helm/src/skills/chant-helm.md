---
skill: chant-helm
description: Build, validate, and deploy Helm charts from a chant project
user-invocable: true
---

# Helm Chart Operational Playbook

## How chant and Helm relate

chant is a **synthesis compiler** — it compiles TypeScript source files into a complete Helm chart directory (Chart.yaml, values.yaml, templates/, etc.). `chant build` does not call the Helm CLI; synthesis is pure and deterministic. Your job as an agent is to bridge synthesis and deployment:

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

### Build the chart

```bash
chant build                              # synthesize TypeScript → dist/
chant build --watch                      # rebuild on source changes
chant build --output my-chart/           # write to a custom directory
```

`chant build` produces a complete Helm chart directory:
- `dist/Chart.yaml` — chart metadata (name, version, apiVersion v2)
- `dist/values.yaml` — default values extracted from `values` proxy usage
- `dist/templates/*.yaml` — rendered K8s manifests with Go template directives
- `dist/templates/_helpers.tpl` — named templates (fullname, labels, etc.)
- `dist/templates/NOTES.txt` — post-install instructions

### Lint and validate

```bash
# Lint the TypeScript (pre-synth rules)
chant lint

# Validate the generated chart (post-synth checks)
chant check

# Validate with helm CLI
helm lint dist/
helm template test dist/
```

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| `chant lint` | Pre-synth: missing chart metadata, bare secrets in values, hardcoded images | Every edit |
| `chant check` | Post-synth: unbalanced template braces, missing _helpers.tpl, deprecated APIs, security issues | After build |
| `helm lint dist/` | Chart structure validation, values schema, template rendering errors | Before publish |
| `helm template test dist/` | Full template rendering with default values — catches nil pointer panics in Go templates | Before publish |
| `helm template test dist/ -f values-prod.yaml` | Template rendering with environment-specific overrides | Before deploy |

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
import { HelmWebApp, HelmMicroservice, HelmDaemonSet, HelmWorker } from "@intentius/chant-lexicon-helm";

// Quick scaffold: Deployment + Service + Ingress + HPA + ServiceAccount
const result = HelmWebApp({ name: "my-app", port: 3000, replicas: 3 });

// Full microservice: + PDB + ConfigMap + health probes + resource limits
const msvc = HelmMicroservice({ name: "api", port: 8080 });

// DaemonSet for node-level agents (logging, monitoring)
const agent = HelmDaemonSet({ name: "log-agent", imageRepository: "fluent/fluent-bit" });

// Worker for background processors (no Service, exec probes, queue config)
const worker = HelmWorker({ name: "job-processor", replicas: 4 });
```

### Composites reference

| Need | Composite | Resources |
|------|-----------|-----------|
| Stateless web app | **HelmWebApp** | Deployment + Service + optional Ingress + HPA + ServiceAccount |
| Production microservice | **HelmMicroservice** | Deployment + Service + HPA + PDB + ConfigMap + probes + limits |
| Stateful database/cache | **HelmStatefulService** | StatefulSet + headless Service + PVC + optional PDB |
| Background workers | **HelmWorker** | Deployment + optional HPA (no Service, exec probes) |
| Node-level agent | **HelmDaemonSet** | DaemonSet + ServiceAccount + RBAC |
| Scheduled jobs | **HelmCronJob** | CronJob + ServiceAccount + RBAC |
| One-shot batch jobs | **HelmBatchJob** | Job + ServiceAccount + optional RBAC |
| App with Prometheus monitoring | **HelmMonitoredService** | Deployment + Service + ServiceMonitor + optional PrometheusRule |
| TLS Ingress (cert-manager) | **HelmSecureIngress** | Ingress + optional Certificate |
| External secrets (Vault, AWS SM) | **HelmExternalSecret** | ExternalSecret + SecretStore ref |
| CRD lifecycle hooks | **HelmCRDLifecycle** | pre-install/upgrade Job for CRD apply |
| Library chart (no templates) | **HelmLibrary** | Chart.yaml with `type: library` + _helpers.tpl |
| Namespace with quotas | **HelmNamespaceEnv** | Namespace + ResourceQuota + LimitRange + NetworkPolicy |

### Secret management with ExternalSecret

```typescript
import { HelmExternalSecret } from "@intentius/chant-lexicon-helm";

const secrets = HelmExternalSecret({
  name: "app-secrets",
  secretStoreName: "vault",
  data: {
    DB_PASSWORD: "secret/data/db-password",
    API_KEY: "secret/data/api-key",
  },
});
```

### Resource ordering

```typescript
import { withOrder, argoWave } from "@intentius/chant-lexicon-helm";

// Helm hook ordering (lower weight = runs first)
metadata: { annotations: { ...withOrder(-5) } }

// Argo CD sync waves
metadata: { annotations: { ...argoWave(2) } }
```

### CRD lifecycle management

```typescript
import { HelmCRDLifecycle } from "@intentius/chant-lexicon-helm";

// Managed CRD lifecycle via Helm hooks (solves Helm's CRD limitation)
const lifecycle = HelmCRDLifecycle({
  name: "my-operator",
  crdContent: crdYaml,
});
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
| WHM401 | Image uses :latest tag or no tag |
| WHM402 | runAsNonRoot not set |
| WHM403 | readOnlyRootFilesystem not set |
| WHM404 | privileged: true detected |
| WHM405 | Resource spec missing cpu/memory |
| WHM406 | CRD lifecycle limitation |
| WHM407 | Secret with inline data |
| WHM501 | Unused values keys |
| WHM502 | Deprecated K8s API versions |

## OCI registry workflow

Helm 3.8+ supports OCI registries as first-class chart repositories.

```bash
# Login to an OCI registry
helm registry login ghcr.io -u <user>
helm registry login <account>.dkr.ecr.<region>.amazonaws.com --username AWS --password $(aws ecr get-login-password)

# Package the chart
helm package dist/

# Push to OCI registry
helm push my-app-1.0.0.tgz oci://ghcr.io/my-org/charts
helm push my-app-1.0.0.tgz oci://<account>.dkr.ecr.<region>.amazonaws.com/charts

# Pull from OCI registry
helm pull oci://ghcr.io/my-org/charts/my-app --version 1.0.0

# Install directly from OCI
helm install my-app oci://ghcr.io/my-org/charts/my-app --version 1.0.0
```

## Chart testing

### helm test

Helm tests are pods defined in `templates/tests/` with the `helm.sh/hook: test` annotation. They run after install/upgrade.

```bash
helm install my-app dist/
helm test my-app                          # run test pods
helm test my-app --logs                   # show test pod logs
```

### chart-testing (ct)

The `ct` tool validates charts against a set of rules and optionally installs them in a Kind cluster.

```bash
# Lint all changed charts
ct lint --charts dist/

# Lint + install (requires a running cluster)
ct install --charts dist/

# CI-oriented: lint and install only changed charts
ct lint-and-install --chart-dirs dist/
```

## Deploy lifecycle

### Install a release

```bash
# Build the chart first
chant build

# Install with default values
helm install my-app dist/

# Install with overrides
helm install my-app dist/ -f values-prod.yaml
helm install my-app dist/ --set replicaCount=3 --set image.tag=v2.0.0

# Install in a specific namespace (create if missing)
helm install my-app dist/ -n production --create-namespace

# Dry run (renders templates, validates against cluster)
helm install my-app dist/ --dry-run
```

### Upgrade a release

```bash
# Upgrade with new chart
chant build
helm upgrade my-app dist/

# Upgrade with value overrides
helm upgrade my-app dist/ -f values-prod.yaml --set image.tag=v2.1.0

# Atomic upgrade (auto-rollback on failure)
helm upgrade my-app dist/ --atomic --timeout 5m

# Install or upgrade (idempotent)
helm upgrade --install my-app dist/ -f values-prod.yaml
```

### Rollback a release

```bash
# View release history
helm history my-app

# Rollback to previous revision
helm rollback my-app

# Rollback to a specific revision
helm rollback my-app 3

# Rollback with timeout
helm rollback my-app 3 --timeout 5m
```

### Uninstall

```bash
helm uninstall my-app
helm uninstall my-app --keep-history      # preserve history for rollback
```

## Troubleshooting

### Common errors

#### "apiVersion must be v2"
Helm 3 requires `apiVersion: v2` in Chart.yaml. Update your Chart metadata.

#### "unbalanced template braces"
A Go template expression has mismatched `{{` / `}}`. Check your intrinsic usage.

#### "hardcoded image tag"
Use `printf("%s:%s", values.image.repository, values.image.tag)` instead of literal strings for container images.

#### "UPGRADE FAILED: another operation is in progress"
A previous install/upgrade was interrupted. Fix with:
```bash
helm history my-app
helm rollback my-app <last-good-revision>
```
If stuck in `pending-install`, uninstall and reinstall:
```bash
helm uninstall my-app
helm install my-app dist/
```

#### "rendered manifests contain a resource that already exists"
Another release or kubectl owns the resource. Add `--force` or use `kubectl annotate` to transfer ownership:
```bash
kubectl annotate <resource> meta.helm.sh/release-name=my-app --overwrite
kubectl annotate <resource> meta.helm.sh/release-namespace=default --overwrite
kubectl label <resource> app.kubernetes.io/managed-by=Helm --overwrite
```

### Troubleshooting decision tree

```
helm install/upgrade failed?
├─ "INSTALLATION FAILED: cannot re-use a name"
│  └─ Release name in use → helm uninstall <name> or pick a new name
├─ "UPGRADE FAILED: another operation is in progress"
│  └─ Stuck release → helm rollback to last good revision
├─ "rendered manifests contain a resource that already exists"
│  └─ Ownership conflict → annotate existing resources with Helm metadata
├─ Template rendering error
│  ├─ "nil pointer evaluating interface"
│  │  └─ Missing values → add defaults in values.yaml or guard with {{- if }}
│  ├─ "function X not defined"
│  │  └─ Missing _helpers.tpl → ensure include() references defined templates
│  └─ "wrong type for value"
│     └─ Type mismatch → check values.yaml types match template expectations
├─ Pods not starting after deploy
│  └─ See kubectl debugging: kubectl get pods, describe, logs --previous
└─ Helm test failing
   ├─ Test pod CrashLoopBackOff → check test script, endpoint connectivity
   └─ Timeout → increase --timeout or fix service readiness
```

## Quick reference

```bash
# Build
chant build                               # synthesize chart
chant lint                                # pre-synth lint
chant check                              # post-synth checks

# Validate
helm lint dist/                           # chart structure
helm template test dist/                  # render templates
helm template test dist/ -f values-prod.yaml  # render with overrides

# Deploy
helm install my-app dist/                 # install
helm upgrade my-app dist/                 # upgrade
helm upgrade --install my-app dist/       # idempotent install/upgrade
helm rollback my-app                      # rollback to previous

# Inspect
helm list                                 # list releases
helm history my-app                       # release history
helm get values my-app                    # current values
helm get manifest my-app                  # current manifests

# Test
helm test my-app --logs                   # run chart tests

# Package and publish
helm package dist/                        # create .tgz
helm push my-app-1.0.0.tgz oci://registry/charts  # push to OCI

# Cleanup
helm uninstall my-app                     # remove release
```
