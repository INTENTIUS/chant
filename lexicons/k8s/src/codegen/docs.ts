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
Ingress, RBAC, and 50+ additional resource and property types.

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

The lexicon provides **50+ resource types** (Deployment, Service, ConfigMap, StatefulSet, and more), **35+ property types** (Container, Probe, Volume, SecurityContext, etc.), and composites (WebApp, StatefulApp, CronWorkload, AutoscaledService, WorkerPool, NamespaceEnv, NodeAgent) for common patterns.
`;

const outputFormat = `The Kubernetes lexicon serializes resources into **multi-document YAML** with
\`---\` separators between resources. Each resource gets the standard K8s
structure: \`apiVersion\`, \`kind\`, \`metadata\`, and \`spec\`.

## Building

Run \`chant build\` to produce Kubernetes manifests from your declarations:

\`\`\`bash
chant build
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
    extraPages: [
      {
        slug: "kubernetes-concepts",
        title: "Kubernetes Concepts",
        description: "How Kubernetes resources map to chant constructs — apiVersion, kind, metadata, spec",
        content: `Every exported resource declaration becomes a Kubernetes manifest document in the generated YAML. The serializer handles the translation automatically:

- Resolves the correct \`apiVersion\` and \`kind\` from the resource type
- Converts the export name to a kebab-case \`metadata.name\`
- Nests user properties under \`spec\` (or at the top level for specless types like ConfigMap)
- Merges default labels and annotations from \`defaultLabels()\`/\`defaultAnnotations()\`

## Resource structure

Every Kubernetes resource has four standard fields:

| Field | Source | Example |
|-------|--------|---------|
| \`apiVersion\` | Resolved from resource type | \`apps/v1\` |
| \`kind\` | Resolved from resource type | \`Deployment\` |
| \`metadata\` | From \`metadata\` property | \`{ name: "my-app", labels: {...} }\` |
| \`spec\` | From \`spec\` property or remaining props | Resource-specific configuration |

## API groups

K8s resources are organized by API group:

| Group | apiVersion | Resources |
|-------|-----------|-----------|
| Core | \`v1\` | Pod, Service, ConfigMap, Secret, Namespace, ServiceAccount |
| Apps | \`apps/v1\` | Deployment, StatefulSet, DaemonSet, ReplicaSet |
| Batch | \`batch/v1\` | Job, CronJob |
| Networking | \`networking.k8s.io/v1\` | Ingress, NetworkPolicy |
| RBAC | \`rbac.authorization.k8s.io/v1\` | Role, ClusterRole, RoleBinding, ClusterRoleBinding |
| Autoscaling | \`autoscaling/v2\` | HorizontalPodAutoscaler |
| Policy | \`policy/v1\` | PodDisruptionBudget |

## Property types

Nested objects like containers, probes, and volumes are expressed as property types:

\`\`\`typescript
import { Deployment, Container, Probe, ResourceRequirements } from "@intentius/chant-lexicon-k8s";

export const app = new Deployment({
  metadata: { name: "my-app" },
  spec: {
    replicas: 2,
    selector: { matchLabels: { app: "my-app" } },
    template: {
      metadata: { labels: { app: "my-app" } },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "my-app:1.0",
            resources: new ResourceRequirements({
              limits: { cpu: "500m", memory: "256Mi" },
              requests: { cpu: "100m", memory: "128Mi" },
            }),
            livenessProbe: new Probe({
              httpGet: { path: "/healthz", port: 8080 },
              initialDelaySeconds: 10,
            }),
          }),
        ],
      },
    },
  },
});
\`\`\`

## Specless types

Some K8s resources (ConfigMap, Secret, Namespace, ServiceAccount) don't have a \`spec\` field. Their data goes directly on the manifest:

\`\`\`typescript
import { ConfigMap, Secret } from "@intentius/chant-lexicon-k8s";

export const config = new ConfigMap({
  metadata: { name: "app-config" },
  data: { DATABASE_URL: "postgres://localhost:5432/mydb" },
});

export const secret = new Secret({
  metadata: { name: "app-secret" },
  stringData: { API_KEY: "changeme" },
});
\`\`\`

## Default labels and annotations

Use \`defaultLabels()\` and \`defaultAnnotations()\` to inject metadata into all resources:

\`\`\`typescript
import { defaultLabels } from "@intentius/chant-lexicon-k8s";

export const labels = defaultLabels({
  "app.kubernetes.io/managed-by": "chant",
  "app.kubernetes.io/part-of": "my-system",
});
\`\`\`

Explicit labels on individual resources take precedence over defaults.`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for Kubernetes manifests",
        content: `The Kubernetes lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized YAML after \`chant build\`.

## Lint rules

Lint rules analyze your TypeScript source code before build.

### WK8001 — Hardcoded namespace

**Severity:** warning | **Category:** correctness

Flags hardcoded namespace strings in resource constructors. Namespaces should be parameterized or derived from configuration.

\`\`\`typescript
// Bad — hardcoded namespace
new Deployment({ metadata: { namespace: "production" } });

// Good — parameterized
new Deployment({ metadata: { namespace: config.namespace } });
\`\`\`

## Post-synth checks

Post-synth checks run against the serialized YAML after build.

### Security

| Rule | Description |
|------|-------------|
| WK8005 | Hardcoded secrets in environment variables |
| WK8041 | API keys detected in env values |
| WK8042 | Private keys in ConfigMaps or Secrets |
| WK8202 | Privileged container (\`privileged: true\`) |
| WK8203 | Writable root filesystem (\`readOnlyRootFilesystem\` not set) |
| WK8204 | Container running as root (\`runAsNonRoot\` not set) |
| WK8205 | Capabilities not dropped (\`drop: ["ALL"]\` missing) |
| WK8207 | Host network access (\`hostNetwork: true\`) |
| WK8208 | Host PID namespace (\`hostPID: true\`) |
| WK8209 | Host IPC namespace (\`hostIPC: true\`) |

### Best practices

| Rule | Description |
|------|-------------|
| WK8006 | Latest image tag or untagged image |
| WK8101 | Deployment selector doesn't match template labels |
| WK8102 | Resource missing metadata.labels |
| WK8103 | Container missing name |
| WK8104 | Unnamed container ports |
| WK8105 | Missing imagePullPolicy |

### Reliability

| Rule | Description |
|------|-------------|
| WK8201 | Container missing resource limits |
| WK8301 | Container missing health probes (skips Jobs/CronJobs) |
| WK8302 | Single replica Deployment |
| WK8303 | HA Deployment without PodDisruptionBudget |

## Running lint

\`\`\`bash
# Lint your chant project
chant lint

# Build (also runs post-synth checks)
chant build
\`\`\`

To suppress a rule on a specific line:

\`\`\`typescript
// chant-disable-next-line WK8001
export const deploy = new Deployment({ metadata: { namespace: "prod" } });
\`\`\`

To suppress globally in \`chant.config.ts\`:

\`\`\`typescript
export default {
  lint: {
    rules: {
      WK8001: "off",
    },
  },
};
\`\`\`
`,
      },
      {
        slug: "examples",
        title: "Examples: Resources",
        description: "Walkthrough of Kubernetes resource examples — deployments, services, autoscaling",
        content: `## Basic Deployment

A Deployment with Service — the most common pattern for stateless web apps:

\`\`\`typescript
import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

export const deployment = new Deployment({
  metadata: { name: "web", labels: { "app.kubernetes.io/name": "web" } },
  spec: {
    replicas: 3,
    selector: { matchLabels: { "app.kubernetes.io/name": "web" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "web" } },
      spec: {
        containers: [
          new Container({
            name: "web",
            image: "nginx:1.25",
            ports: [{ containerPort: 80, name: "http" }],
            livenessProbe: new Probe({ httpGet: { path: "/", port: 80 } }),
            readinessProbe: new Probe({ httpGet: { path: "/", port: 80 } }),
          }),
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: { name: "web" },
  spec: {
    selector: { "app.kubernetes.io/name": "web" },
    ports: [{ port: 80, targetPort: 80 }],
  },
});
\`\`\`

## Microservice with HPA

Production-ready microservice with autoscaling and disruption budget:

\`\`\`typescript
import {
  Deployment, Service, HorizontalPodAutoscaler, PodDisruptionBudget,
  Container, Probe, ResourceRequirements,
} from "@intentius/chant-lexicon-k8s";

export const deployment = new Deployment({
  metadata: { name: "api", labels: { "app.kubernetes.io/name": "api" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "api" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "api" } },
      spec: {
        containers: [
          new Container({
            name: "api",
            image: "api:1.0",
            ports: [{ containerPort: 8080, name: "http" }],
            resources: new ResourceRequirements({
              limits: { cpu: "500m", memory: "256Mi" },
              requests: { cpu: "100m", memory: "128Mi" },
            }),
            livenessProbe: new Probe({ httpGet: { path: "/healthz", port: 8080 } }),
            readinessProbe: new Probe({ httpGet: { path: "/readyz", port: 8080 } }),
          }),
        ],
      },
    },
  },
});

export const hpa = new HorizontalPodAutoscaler({
  metadata: { name: "api" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "api" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [
      { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } },
    ],
  },
});

export const pdb = new PodDisruptionBudget({
  metadata: { name: "api" },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "api" } },
  },
});
\`\`\`

## Stateful Application

Database deployment with persistent storage using the StatefulApp composite:

\`\`\`typescript
import { StatefulApp } from "@intentius/chant-lexicon-k8s";

const { statefulSet, service } = StatefulApp({
  name: "postgres",
  image: "postgres:16",
  port: 5432,
  storageSize: "20Gi",
  replicas: 3,
  env: [{ name: "POSTGRES_DB", value: "mydb" }],
});
\`\`\`
`,
      },
      {
        slug: "composite-examples",
        title: "Examples: Composites",
        description: "Composite examples — WebApp, CronWorkload, AutoscaledService, WorkerPool, NamespaceEnv, NodeAgent",
        content: `Composites are higher-level constructs that produce multiple coordinated K8s resources from a single function call.

## WebApp

Quick deployment with Deployment + Service + optional Ingress:

\`\`\`typescript
import { WebApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service, ingress } = WebApp({
  name: "frontend",
  image: "frontend:1.0",
  port: 3000,
  replicas: 3,
  ingressHost: "frontend.example.com",
  ingressTlsSecret: "frontend-tls",
});
\`\`\`

## CronWorkload

Scheduled workload with RBAC:

\`\`\`typescript
import { CronWorkload } from "@intentius/chant-lexicon-k8s";

const { cronJob, serviceAccount, role, roleBinding } = CronWorkload({
  name: "db-backup",
  image: "postgres:16",
  schedule: "0 2 * * *",
  command: ["pg_dump", "-h", "postgres", "mydb"],
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
});
\`\`\`

## AutoscaledService

Production HTTP service with HPA, PDB, and configurable probes:

\`\`\`typescript
import { AutoscaledService } from "@intentius/chant-lexicon-k8s";

const { deployment, service, hpa, pdb } = AutoscaledService({
  name: "api",
  image: "api:2.0",
  port: 8080,
  maxReplicas: 10,
  minReplicas: 3,
  targetCPUPercent: 60,
  targetMemoryPercent: 80,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  cpuLimit: "1",
  memoryLimit: "1Gi",
  livenessPath: "/healthz",
  readinessPath: "/readyz",
  topologySpread: true,
  namespace: "production",
});
\`\`\`

## WorkerPool

Background queue worker with RBAC and optional autoscaling:

\`\`\`typescript
import { WorkerPool } from "@intentius/chant-lexicon-k8s";

const { deployment, serviceAccount, role, roleBinding, configMap, hpa } = WorkerPool({
  name: "email-worker",
  image: "worker:1.0",
  command: ["bundle", "exec", "sidekiq"],
  config: { REDIS_URL: "redis://redis:6379", QUEUE: "emails" },
  autoscaling: { minReplicas: 2, maxReplicas: 20, targetCPUPercent: 60 },
});
\`\`\`

Pass \`rbacRules: []\` to opt out of RBAC resource creation entirely.

## NamespaceEnv

Multi-tenant namespace with resource guardrails and network isolation:

\`\`\`typescript
import { NamespaceEnv } from "@intentius/chant-lexicon-k8s";

const { namespace, resourceQuota, limitRange, networkPolicy } = NamespaceEnv({
  name: "team-alpha",
  cpuQuota: "8",
  memoryQuota: "16Gi",
  maxPods: 50,
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "500m",
  defaultMemoryLimit: "512Mi",
  defaultDenyIngress: true,
  defaultDenyEgress: true,
});
\`\`\`

Setting a ResourceQuota without LimitRange defaults will emit a warning — pods without explicit resource requests will fail to schedule.

## NodeAgent

Per-node DaemonSet agent with cluster-wide RBAC and host path mounts:

\`\`\`typescript
import { NodeAgent } from "@intentius/chant-lexicon-k8s";

const { daemonSet, serviceAccount, clusterRole, clusterRoleBinding, configMap } = NodeAgent({
  name: "log-collector",
  image: "fluentd:v1.16",
  port: 24224,
  hostPaths: [
    { name: "varlog", hostPath: "/var/log", mountPath: "/var/log" },
    { name: "containers", hostPath: "/var/lib/docker/containers", mountPath: "/var/lib/docker/containers" },
  ],
  config: { "fluent.conf": "<source>\\n  @type tail\\n  path /var/log/*.log\\n</source>" },
  rbacRules: [
    { apiGroups: [""], resources: ["pods", "namespaces"], verbs: ["get", "list", "watch"] },
  ],
  namespace: "monitoring",
});
\`\`\`

## Deploying composites

Composites produce plain prop objects. To deploy them, write each resource to a \`.k8s.ts\` file then use the standard chant build → kubectl apply workflow.

### Step 1 — Write a chant source file

\`\`\`typescript
// src/infra.k8s.ts
import { AutoscaledService, NamespaceEnv, WorkerPool, NodeAgent } from "@intentius/chant-lexicon-k8s";

// Namespace with guardrails
const nsEnv = NamespaceEnv({
  name: "production",
  cpuQuota: "16",
  memoryQuota: "32Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultCpuLimit: "1",
  defaultMemoryLimit: "512Mi",
});
export const { namespace, resourceQuota, limitRange, networkPolicy } = nsEnv;

// API with autoscaling
const api = AutoscaledService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  topologySpread: true,
  namespace: "production",
});
export const { deployment, service, hpa, pdb } = api;

// Background workers
const workers = WorkerPool({
  name: "email-worker",
  image: "worker:1.0",
  command: ["bundle", "exec", "sidekiq"],
  config: { REDIS_URL: "redis://redis:6379" },
  autoscaling: { minReplicas: 2, maxReplicas: 20 },
  namespace: "production",
});
export const workerDeployment = workers.deployment;
export const workerSA = workers.serviceAccount;
export const workerRole = workers.role;
export const workerRoleBinding = workers.roleBinding;
export const workerConfig = workers.configMap;
export const workerHPA = workers.hpa;
\`\`\`

### Step 2 — Build and validate

\`\`\`bash
# Build YAML manifests
chant build src/ --output manifests.yaml

# Lint for common issues
chant lint src/

# Server-side dry run (validates with admission webhooks)
kubectl apply -f manifests.yaml --dry-run=server
\`\`\`

### Step 3 — Deploy

\`\`\`bash
# Diff before applying
kubectl diff -f manifests.yaml

# Apply
kubectl apply -f manifests.yaml

# Verify rollout
kubectl rollout status deployment/api -n production
kubectl get pods,svc,hpa -n production
\`\`\`

### k3d local validation

For local testing before pushing to a real cluster:

\`\`\`bash
cd lexicons/k8s

# Create a k3d cluster, apply composites, verify, and delete
just k3d-validate-composites

# Keep the cluster for manual inspection
just k3d-validate-composites --keep-cluster

# Reuse an existing cluster
just k3d-validate-composites --reuse-cluster --verbose
\`\`\`

The \`/chant-k8s\` AI skill covers the full lifecycle — scaffold, build, lint, apply, rollback, and troubleshooting.
`,
      },
      {
        slug: "testing",
        title: "Testing & Validation",
        description: "Roundtrip tests and k3d cluster validation for the Kubernetes lexicon",
        content: `The Kubernetes lexicon includes scripts to verify the full import–serialize roundtrip and validate serialized YAML against a real cluster.

## Roundtrip tests

The roundtrip test suite clones \`kubernetes/examples\` and runs each manifest through the full pipeline:

\`\`\`
Input YAML → parse → generate TS → dynamic import → serialize YAML → re-parse → compare
\`\`\`

**"Pass" means** the serialized YAML, when re-parsed, produces the same number of resources with matching \`kind\` values. Exact YAML comparison is intentionally skipped — key ordering, quoting, and comments differ between input and output.

### Running

\`\`\`bash
cd lexicons/k8s

# Full roundtrip (clones repo on first run)
just full-roundtrip

# Skip clone if repo is already cached
just full-roundtrip --skip-clone

# Parse + generate only (skip serialize phase)
just full-roundtrip --skip-clone --skip-serialize

# Verbose output + filter to a specific manifest
just full-roundtrip --skip-clone --verbose --manifest guestbook
\`\`\`

The test requires \`just generate\` to have been run first so the generated index exports real constructors. If the generated index is empty, the test falls back to parse-only mode automatically.

### Parse-only roundtrip

The original parse-only roundtrip test is still available:

\`\`\`bash
just import-samples --skip-clone --verbose
\`\`\`

## k3d cluster validation

The k3d validation script applies serialized YAML to a real Kubernetes cluster to verify the output is valid and deployable.

### Prerequisites

- [k3d](https://k3d.io/) — lightweight K8s cluster in Docker
- [kubectl](https://kubernetes.io/docs/tasks/tools/) — Kubernetes CLI
- Docker running

### Running

\`\`\`bash
cd lexicons/k8s

# Create cluster, run tests, delete cluster
just k3d-validate

# Keep cluster for manual inspection
just k3d-validate --keep-cluster

# Reuse an existing cluster
just k3d-validate --reuse-cluster --verbose
\`\`\`

After \`--keep-cluster\`, inspect resources manually:

\`\`\`bash
kubectl get all
kubectl get deployments,services
\`\`\`

### Safe manifest allowlist

The script uses a curated allowlist of ~14 manifests known to work on bare k3d (no cloud volumes, CRDs, or GPUs). These include:

- **Guestbook** — Deployments and Services for frontend + Redis
- **Cassandra** — Headless Service
- **vLLM** — Service

### What it validates

For each manifest the script:

1. Runs the full roundtrip (YAML → Chant DSL → YAML)
2. Applies the serialized YAML with \`kubectl apply\`
3. Verifies the resource exists with \`kubectl get\`

A failure at any stage is reported with the specific phase that failed.`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the Kubernetes lexicon",
        content: `The Kubernetes lexicon ships an AI skill called **chant-k8s** that teaches AI coding agents how to build, validate, and deploy Kubernetes manifests from a chant project.

## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically — giving it operational knowledge about the deployment workflow without requiring the user to explain each step.

## Installation

When you scaffold a new project with \`chant init --lexicon k8s\`, the skill is installed to \`.claude/skills/chant-k8s/SKILL.md\` for automatic discovery by Claude Code.

## Skill: chant-k8s

The \`chant-k8s\` skill covers the full deployment lifecycle:

- **Build** — \`chant build src/ --output manifests.yaml\`
- **Lint** — \`chant lint src/\` + post-synth checks (20 rules)
- **Apply** — \`kubectl apply -f manifests.yaml\`
- **Status** — \`kubectl get pods,svc,deploy\`
- **Rollback** — \`kubectl rollout undo deployment/my-app\`
- **Troubleshooting** — pod status, logs, events, common error patterns

The skill is invocable as a slash command: \`/chant-k8s\`

## MCP integration

The lexicon also provides MCP (Model Context Protocol) tools and resources:

| MCP tool | Description |
|----------|-------------|
| \`diff\` | Compare current build output against previous |

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported K8s resource types |
| \`examples/basic-deployment\` | Example Deployment + Service code |`,
      },
    ],
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
