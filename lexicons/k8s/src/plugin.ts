/**
 * Kubernetes lexicon plugin.
 *
 * Provides serializer, template detection, code generation,
 * lint rules, and LSP/MCP integration for Kubernetes manifests.
 */

import { createRequire } from "module";
import type { LexiconPlugin, SkillDefinition, InitTemplateSet } from "@intentius/chant/lexicon";
const require = createRequire(import.meta.url);
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { k8sSerializer } from "./serializer";

export const k8sPlugin: LexiconPlugin = {
  name: "k8s",
  serializer: k8sSerializer,

  lintRules(): LintRule[] {
    const { hardcodedNamespaceRule } = require("./lint/rules/hardcoded-namespace");
    return [hardcodedNamespaceRule];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { wk8005 } = require("./lint/post-synth/wk8005");
    const { wk8006 } = require("./lint/post-synth/wk8006");
    const { wk8041 } = require("./lint/post-synth/wk8041");
    const { wk8042 } = require("./lint/post-synth/wk8042");
    const { wk8101 } = require("./lint/post-synth/wk8101");
    const { wk8102 } = require("./lint/post-synth/wk8102");
    const { wk8103 } = require("./lint/post-synth/wk8103");
    const { wk8104 } = require("./lint/post-synth/wk8104");
    const { wk8105 } = require("./lint/post-synth/wk8105");
    const { wk8201 } = require("./lint/post-synth/wk8201");
    const { wk8202 } = require("./lint/post-synth/wk8202");
    const { wk8203 } = require("./lint/post-synth/wk8203");
    const { wk8204 } = require("./lint/post-synth/wk8204");
    const { wk8205 } = require("./lint/post-synth/wk8205");
    const { wk8207 } = require("./lint/post-synth/wk8207");
    const { wk8208 } = require("./lint/post-synth/wk8208");
    const { wk8209 } = require("./lint/post-synth/wk8209");
    const { wk8301 } = require("./lint/post-synth/wk8301");
    const { wk8302 } = require("./lint/post-synth/wk8302");
    const { wk8303 } = require("./lint/post-synth/wk8303");
    const { wk8304 } = require("./lint/post-synth/wk8304");
    const { wk8305 } = require("./lint/post-synth/wk8305");
    const { wk8306 } = require("./lint/post-synth/wk8306");
    return [
      wk8005, wk8006, wk8041, wk8042,
      wk8101, wk8102, wk8103, wk8104, wk8105,
      wk8201, wk8202, wk8203, wk8204, wk8205, wk8207, wk8208, wk8209,
      wk8301, wk8302, wk8303, wk8304, wk8305, wk8306,
    ];
  },

  // K8s YAML has no template interpolation functions like CloudFormation's
  // Fn::Sub or GitLab's !reference. Cross-resource references are handled by
  // the AttrRef system in the serializer (resolves to metadata.name).
  // ConfigMap/Secret valueFrom references are expressed as plain property
  // values, not intrinsics.
  intrinsics() {
    return [];
  },

  initTemplates(template?: string): InitTemplateSet {
    if (template === "microservice") {
      return {
        src: {
          "infra.ts": `import { Deployment, Service, HorizontalPodAutoscaler, PodDisruptionBudget, Container, Probe, ResourceRequirements } from "@intentius/chant-lexicon-k8s";

export const deployment = new Deployment({
  metadata: { name: "my-service", labels: { "app.kubernetes.io/name": "my-service" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-service" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "my-service" } },
      spec: {
        containers: [
          new Container({
            name: "app",
            image: "my-service:latest",
            ports: [{ containerPort: 8080, name: "http" }],
            resources: new ResourceRequirements({
              limits: { cpu: "500m", memory: "256Mi" },
              requests: { cpu: "100m", memory: "128Mi" },
            }),
            livenessProbe: new Probe({ httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 10 }),
            readinessProbe: new Probe({ httpGet: { path: "/readyz", port: 8080 }, initialDelaySeconds: 5 }),
          }),
        ],
      },
    },
  },
});

export const service = new Service({
  metadata: { name: "my-service", labels: { "app.kubernetes.io/name": "my-service" } },
  spec: {
    selector: { "app.kubernetes.io/name": "my-service" },
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
  },
});

export const hpa = new HorizontalPodAutoscaler({
  metadata: { name: "my-service" },
  spec: {
    scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "my-service" },
    minReplicas: 2,
    maxReplicas: 10,
    metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 70 } } }],
  },
});

export const pdb = new PodDisruptionBudget({
  metadata: { name: "my-service" },
  spec: {
    minAvailable: 1,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-service" } },
  },
});
`,
        },
      };
    }

    if (template === "stateful") {
      return {
        src: {
          "infra.ts": `import { StatefulSet, Service } from "@intentius/chant-lexicon-k8s";

export const statefulSet = new StatefulSet({
  metadata: { name: "my-db", labels: { "app.kubernetes.io/name": "my-db" } },
  spec: {
    serviceName: "my-db",
    replicas: 3,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-db" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "my-db" } },
      spec: {
        containers: [
          {
            name: "db",
            image: "postgres:16",
            ports: [{ containerPort: 5432, name: "postgres" }],
            volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
            env: [
              { name: "POSTGRES_DB", value: "mydb" },
            ],
          },
        ],
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "10Gi" } },
        },
      },
    ],
  },
});

export const service = new Service({
  metadata: { name: "my-db", labels: { "app.kubernetes.io/name": "my-db" } },
  spec: {
    selector: { "app.kubernetes.io/name": "my-db" },
    ports: [{ port: 5432, targetPort: 5432, name: "postgres" }],
    clusterIP: "None",
  },
});
`,
        },
      };
    }

    // Default template — Deployment + Service
    return {
      src: {
        "infra.ts": `import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

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
            image: "my-app:latest",
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
  metadata: { name: "my-app", labels: { "app.kubernetes.io/name": "my-app" } },
  spec: {
    selector: { "app.kubernetes.io/name": "my-app" },
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP", name: "http" }],
  },
});
`,
      },
    };
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;

    // K8s manifests have apiVersion + kind
    if (typeof obj.apiVersion === "string" && typeof obj.kind === "string") return true;

    return false;
  },

  completionProvider(ctx: import("@intentius/chant/lsp/types").CompletionContext) {
    const { k8sCompletions } = require("./lsp/completions");
    return k8sCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    const { k8sHover } = require("./lsp/hover");
    return k8sHover(ctx);
  },

  templateParser() {
    const { K8sParser } = require("./import/parser");
    return new K8sParser();
  },

  templateGenerator() {
    const { K8sGenerator } = require("./import/generator");
    return new K8sGenerator();
  },

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs(options);
  },

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const result = await generate({ verbose: options?.verbose ?? true });
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeGeneratedFiles(result, pkgDir);

    console.error(
      `Generated ${result.resources} resources, ${result.properties} property types, ${result.enums} enums`,
    );
    if (result.warnings.length > 0) {
      console.error(`${result.warnings.length} warnings`);
    }
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeK8sCoverage } = await import("./coverage");
    await analyzeK8sCoverage({
      verbose: options?.verbose,
      minOverall: options?.minOverall,
    });
  },

  async package(options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    const { packageLexicon } = await import("./codegen/package");
    const { writeBundleSpec } = await import("@intentius/chant/codegen/package");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const { spec, stats } = await packageLexicon({ verbose: options?.verbose, force: options?.force });

    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const distDir = join(pkgDir, "dist");
    writeBundleSpec(spec, distDir);

    console.error(`Packaged ${stats.resources} resources, ${stats.ruleCount} rules, ${stats.skillCount} skills`);
  },

  mcpTools() {
    return [
      {
        name: "diff",
        description: "Compare current build output against previous output for Kubernetes manifests",
        inputSchema: {
          type: "object" as const,
          properties: {
            path: {
              type: "string",
              description: "Path to the infrastructure project directory",
            },
          },
        },
        async handler(params: Record<string, unknown>): Promise<unknown> {
          const { diffCommand } = await import("@intentius/chant/cli/commands/diff");
          const result = await diffCommand({
            path: (params.path as string) ?? ".",
            serializers: [k8sSerializer],
          });
          return result;
        },
      },
    ];
  },

  mcpResources() {
    return [
      {
        uri: "resource-catalog",
        name: "Kubernetes Resource Catalog",
        description: "JSON list of all supported Kubernetes resource types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const lexicon = require("./generated/lexicon-k8s.json") as Record<string, { resourceType: string; kind: string }>;
          const entries = Object.entries(lexicon).map(([className, entry]) => ({
            className,
            resourceType: entry.resourceType,
            kind: entry.kind,
          }));
          return JSON.stringify(entries);
        },
      },
      {
        uri: "examples/basic-deployment",
        name: "Basic Deployment Example",
        description: "A basic Kubernetes Deployment with Service",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Deployment, Service, Container, Probe } from "@intentius/chant-lexicon-k8s";

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
`;
        },
      },
    ];
  },

  skills(): SkillDefinition[] {
    return [
      {
        name: "chant-k8s",
        description: "Kubernetes manifest lifecycle — scaffold, generate, lint, build, apply, troubleshoot, rollback",
        content: `---
skill: chant-k8s
description: Build, validate, and deploy Kubernetes manifests from a chant project
user-invocable: true
---

# Kubernetes Operational Playbook

## How chant and Kubernetes relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into Kubernetes YAML manifests. chant does NOT call the Kubernetes API. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **kubectl / k8s API** for: apply, rollback, monitoring, troubleshooting

The source of truth for infrastructure is the TypeScript in \`src/\`. The generated YAML manifests are intermediate artifacts — never edit them by hand.

## Scaffolding a new project

### Initialize with a template

\`\`\`bash
chant init --lexicon k8s                          # default: Deployment + Service
chant init --lexicon k8s --template microservice   # Deployment + Service + HPA + PDB
chant init --lexicon k8s --template stateful       # StatefulSet + PVC + Service
\`\`\`

### Available templates

| Template | What it generates | Best for |
|----------|-------------------|----------|
| *(default)* | Deployment + Service | Simple stateless apps |
| \`microservice\` | Deployment + Service + HPA + PDB | Production microservices |
| \`stateful\` | StatefulSet + PVC + headless Service | Databases, caches |

## Build and validate

### Build manifests

\`\`\`bash
chant build src/ --output manifests.yaml
\`\`\`

Options:
- \`--format yaml\` — emit YAML (default for K8s)
- \`--watch\` — rebuild on source changes
- \`--output <path>\` — write to a specific file

### Lint the source

\`\`\`bash
chant lint src/
\`\`\`

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| \`chant lint\` | Hardcoded namespaces (WK8001) | Every edit |
| \`chant build\` | Post-synth: secrets in env (WK8005), latest tags (WK8006), API keys (WK8041), missing probes (WK8301), no resource limits (WK8201), privileged containers (WK8202), and more | Before apply |
| \`kubectl --dry-run=server\` | K8s API validation: schema errors, admission webhooks | Before production apply |

## Deploying to Kubernetes

### Apply manifests

\`\`\`bash
# Build
chant build src/ --output manifests.yaml

# Dry run first
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
\`\`\`

### Check rollout status

\`\`\`bash
kubectl rollout status deployment/my-app
\`\`\`

### Rollback

\`\`\`bash
kubectl rollout undo deployment/my-app
kubectl rollout undo deployment/my-app --to-revision=2
\`\`\`

## Debugging strategies

### Check pod status and events

\`\`\`bash
# Overview
kubectl get pods -l app.kubernetes.io/name=my-app
kubectl get events --sort-by=.lastTimestamp -n <namespace>

# Deep dive into a specific pod
kubectl describe pod <pod-name>

# Logs (current and previous crash)
kubectl logs <pod-name>
kubectl logs <pod-name> --previous
kubectl logs <pod-name> -c <container-name>  # specific container
kubectl logs deployment/my-app --all-containers

# Debug containers (K8s 1.25+)
kubectl debug <pod-name> -it --image=busybox --target=<container>

# Port-forwarding for local testing
kubectl port-forward svc/my-app 8080:80
kubectl port-forward pod/<pod-name> 8080:8080
\`\`\`

### Common error patterns

| Status | Meaning | Diagnostic command | Typical fix |
|--------|---------|-------------------|-------------|
| Pending | Not scheduled | \`kubectl describe pod\` → Events | Check resource requests, node selectors, taints, PVC binding |
| CrashLoopBackOff | App crashing on start | \`kubectl logs --previous\` | Fix app startup, check probe config, increase initialDelaySeconds |
| ImagePullBackOff | Image not found | \`kubectl describe pod\` → Events | Verify image name/tag, check imagePullSecrets, registry auth |
| OOMKilled | Out of memory | \`kubectl describe pod\` → Last State | Increase memory limit, profile app memory usage |
| Evicted | Node disk/memory pressure | \`kubectl describe node\` | Increase limits, add node capacity, check for log/tmp bloat |
| CreateContainerError | Container config issue | \`kubectl describe pod\` → Events | Check volume mounts, configmap/secret refs, security context |
| Init:CrashLoopBackOff | Init container failing | \`kubectl logs -c <init-container>\` | Fix init container command, check dependencies |

## Production safety

### Pre-apply validation

\`\`\`bash
# Always diff before applying
kubectl diff -f manifests.yaml

# Server-side dry run (validates with admission webhooks)
kubectl apply -f manifests.yaml --dry-run=server

# Client-side dry run (fast, but no webhook validation)
kubectl apply -f manifests.yaml --dry-run=client
\`\`\`

### Deployment strategies

- **RollingUpdate** (default): Gradually replaces pods. Set \`maxSurge\` and \`maxUnavailable\`.
- **Recreate**: All pods terminated before new ones created. Use for stateful apps that cannot run multiple versions.
- **Canary**: Deploy a second Deployment with 1 replica + same selector labels. Route percentage via Ingress annotations or service mesh.
- **Blue/Green**: Two full Deployments (blue/green), switch Service selector between them.

## Choosing the Right Composite

Composites are higher-level functions that produce multiple coordinated K8s resources from a single call. They return plain prop objects — not class instances.

### Decision Tree

| Need | Composite | Resources |
|------|-----------|-----------|
| Stateless web app | **WebApp** | Deployment + Service + optional Ingress + optional PDB |
| Stateful database/cache | **StatefulApp** | StatefulSet + headless Service + PVC + optional PDB |
| Production HTTP service with autoscaling | **AutoscaledService** | Deployment + Service + HPA + PDB |
| Background queue workers | **WorkerPool** | Deployment + RBAC + optional ConfigMap + optional HPA + optional PDB |
| Scheduled jobs | **CronWorkload** | CronJob + RBAC |
| One-shot batch jobs | **BatchJob** | Job + optional RBAC |
| App with ConfigMap/Secret mounts | **ConfiguredApp** | Deployment + Service + optional ConfigMap |
| Multi-container sidecar patterns | **SidecarApp** | Deployment + Service |
| App with Prometheus monitoring | **MonitoredService** | Deployment + Service + ServiceMonitor + optional PrometheusRule |
| App with fine-grained network policies | **NetworkIsolatedApp** | Deployment + Service + NetworkPolicy |
| Namespace with quotas and isolation | **NamespaceEnv** | Namespace + ResourceQuota + LimitRange + NetworkPolicy |
| Per-node agent (custom) | **NodeAgent** | DaemonSet + RBAC + optional ConfigMap |
| Multi-host TLS Ingress (cert-manager) | **SecureIngress** | Ingress + optional Certificate |
| EKS IRSA ServiceAccount | **IrsaServiceAccount** | ServiceAccount + optional RBAC |
| AWS ALB Ingress | **AlbIngress** | Ingress with ALB annotations |
| EBS StorageClass | **EbsStorageClass** | StorageClass (ebs.csi.aws.com) |
| EFS StorageClass | **EfsStorageClass** | StorageClass (efs.csi.aws.com) |
| Fluent Bit for CloudWatch | **FluentBitAgent** | DaemonSet + RBAC + ConfigMap |
| ExternalDNS for Route53 | **ExternalDnsAgent** | Deployment + IRSA SA + ClusterRole |
| ADOT for CloudWatch/X-Ray | **AdotCollector** | DaemonSet + RBAC + ConfigMap |

### Hardening options (available on Deployment-based composites)

- \`minAvailable\` — creates a PodDisruptionBudget (WebApp, StatefulApp, WorkerPool; AutoscaledService always has one)
- \`initContainers\` — run before main containers (WebApp, StatefulApp, AutoscaledService, ConfiguredApp, SidecarApp)
- \`securityContext\` — container security settings (WebApp, StatefulApp, AutoscaledService, WorkerPool)
- \`terminationGracePeriodSeconds\` — graceful shutdown (WebApp, StatefulApp, AutoscaledService, WorkerPool)
- \`priorityClassName\` — pod scheduling priority (WebApp, StatefulApp, AutoscaledService, WorkerPool)

### Common patterns across all composites

- All resources carry \`app.kubernetes.io/name\`, \`app.kubernetes.io/managed-by: chant\`, and \`app.kubernetes.io/component\` labels
- Pass \`labels: { team: "platform" }\` to add extra labels to all resources
- Pass \`namespace: "prod"\` to set namespace on all namespaced resources
- Pass \`env: [{ name: "KEY", value: "val" }]\` for container environment variables

## Troubleshooting reference table

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| Pod stuck in Pending | Insufficient CPU/memory on nodes | Scale up cluster or reduce resource requests |
| Pod stuck in Pending | PVC not bound | Check StorageClass exists, PV available |
| Pod stuck in Pending | Node selector/affinity mismatch | Verify node labels match selectors |
| Pod stuck in ContainerCreating | ConfigMap/Secret not found | Ensure referenced ConfigMaps/Secrets exist |
| Service returns 503 | No ready endpoints | Check pod readiness probes, selector match |
| Ingress returns 404 | Backend service not found | Check Ingress rules, service name/port |
| HPA not scaling | Metrics server not installed | Install metrics-server |
| HPA not scaling | Resource requests not set | Add CPU/memory requests to containers |
| CronJob not running | Invalid cron expression | Validate cron syntax (5-field format) |
| NetworkPolicy blocking | Default deny applied | Add explicit allow rules for required traffic |
| RBAC permission denied | Missing Role/RoleBinding | Check ServiceAccount bindings and verb permissions |

## Quick reference

\`\`\`bash
# Build
chant build src/ --output manifests.yaml

# Lint
chant lint src/

# Validate
kubectl apply -f manifests.yaml --dry-run=server

# Diff
kubectl diff -f manifests.yaml

# Apply
kubectl apply -f manifests.yaml

# Status
kubectl get pods,svc,deploy

# Logs
kubectl logs deployment/my-app

# Rollback
kubectl rollout undo deployment/my-app

# Debug
kubectl describe pod <name>
kubectl logs <name> --previous
kubectl get events --sort-by=.lastTimestamp
\`\`\`
`,
        triggers: [
          { type: "file-pattern", value: "**/*.k8s.ts" },
          { type: "file-pattern", value: "**/k8s/**/*.ts" },
          { type: "context", value: "kubernetes" },
          { type: "context", value: "k8s" },
          { type: "context", value: "kubectl" },
          { type: "context", value: "deployment" },
          { type: "context", value: "pod" },
          { type: "context", value: "composite" },
          { type: "context", value: "autoscaled" },
          { type: "context", value: "workerpool" },
          { type: "context", value: "namespace-env" },
          { type: "context", value: "node-agent" },
        ],
        preConditions: [
          "chant CLI is installed (chant --version succeeds)",
          "kubectl is configured and can access the cluster",
          "Project has chant source files in src/",
        ],
        postConditions: [
          "All pods are in Running state",
          "No CrashLoopBackOff or Error pods",
        ],
        parameters: [],
        examples: [
          {
            title: "Basic deployment",
            description: "Create a Deployment with Service",
            input: "Create a web app deployment",
            output: `new Deployment({
  metadata: { name: "my-app", labels: { "app.kubernetes.io/name": "my-app" } },
  spec: {
    replicas: 2,
    selector: { matchLabels: { "app.kubernetes.io/name": "my-app" } },
    template: {
      metadata: { labels: { "app.kubernetes.io/name": "my-app" } },
      spec: {
        containers: [{
          name: "app",
          image: "my-app:1.0",
          ports: [{ containerPort: 8080 }],
        }],
      },
    },
  },
})`,
          },
          {
            title: "Deploy to cluster",
            description: "Build and apply manifests",
            input: "Deploy my app to the cluster",
            output: `chant build src/ --output manifests.yaml
kubectl apply -f manifests.yaml --dry-run=server
kubectl apply -f manifests.yaml
kubectl rollout status deployment/my-app`,
          },
          {
            title: "AutoscaledService composite",
            description: "Production HTTP service with HPA, PDB, and zone spreading",
            input: "Create an autoscaled API service",
            output: `import { AutoscaledService } from "@intentius/chant-lexicon-k8s";

const { deployment, service, hpa, pdb } = AutoscaledService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "100m",
  memoryRequest: "128Mi",
  topologySpread: true,
});`,
          },
          {
            title: "BatchJob composite",
            description: "One-shot batch job with RBAC",
            input: "Run a database migration job",
            output: `import { BatchJob } from "@intentius/chant-lexicon-k8s";

const { job, serviceAccount, role, roleBinding } = BatchJob({
  name: "db-migrate",
  image: "api:1.0",
  command: ["python", "manage.py", "migrate"],
  backoffLimit: 3,
  ttlSecondsAfterFinished: 3600,
});`,
          },
        ],
      },
      {
        name: "chant-k8s-eks",
        description: "EKS-specific Kubernetes composites — IRSA, ALB, EBS/EFS, Fluent Bit, ExternalDNS, ADOT",
        content: `---
skill: chant-k8s-eks
description: EKS-specific Kubernetes patterns and composites
user-invocable: true
---

# EKS Kubernetes Patterns

## EKS Composites Overview

These composites produce K8s YAML with EKS-specific annotations and configurations.

### IrsaServiceAccount — ServiceAccount with IAM Role annotation

\`\`\`typescript
import { IrsaServiceAccount } from "@intentius/chant-lexicon-k8s";

const { serviceAccount, role, roleBinding } = IrsaServiceAccount({
  name: "app-sa",
  iamRoleArn: "arn:aws:iam::123456789012:role/my-app-role",
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
  namespace: "prod",
});
\`\`\`

### AlbIngress — Ingress with AWS ALB Controller annotations

\`\`\`typescript
import { AlbIngress } from "@intentius/chant-lexicon-k8s";

const { ingress } = AlbIngress({
  name: "api-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  scheme: "internet-facing",
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
  groupName: "shared-alb",
  healthCheckPath: "/healthz",
});
\`\`\`

Features:
- Auto-sets \`alb.ingress.kubernetes.io/*\` annotations
- SSL redirect enabled by default when \`certificateArn\` set
- \`groupName\` for shared ALB across multiple Ingresses
- \`wafAclArn\` for WAFv2 integration

### EbsStorageClass — StorageClass for EBS CSI

\`\`\`typescript
import { EbsStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = EbsStorageClass({
  name: "gp3-encrypted",
  type: "gp3",
  encrypted: true,
  iops: "3000",
  throughput: "125",
});
\`\`\`

### EfsStorageClass — StorageClass for EFS CSI (ReadWriteMany)

\`\`\`typescript
import { EfsStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = EfsStorageClass({
  name: "efs-shared",
  fileSystemId: "fs-12345678",
});
\`\`\`

Use EFS when you need ReadWriteMany (shared across pods/nodes). Use EBS for ReadWriteOnce (single pod).

### FluentBitAgent — DaemonSet for CloudWatch logging

\`\`\`typescript
import { FluentBitAgent } from "@intentius/chant-lexicon-k8s";

const result = FluentBitAgent({
  logGroup: "/aws/eks/my-cluster/containers",
  region: "us-east-1",
  clusterName: "my-cluster",
});
\`\`\`

### ExternalDnsAgent — ExternalDNS for Route53

\`\`\`typescript
import { ExternalDnsAgent } from "@intentius/chant-lexicon-k8s";

const result = ExternalDnsAgent({
  iamRoleArn: "arn:aws:iam::123456789012:role/external-dns-role",
  domainFilters: ["example.com"],
  txtOwnerId: "my-cluster",
});
\`\`\`

### AdotCollector — ADOT for CloudWatch/X-Ray

\`\`\`typescript
import { AdotCollector } from "@intentius/chant-lexicon-k8s";

const result = AdotCollector({
  region: "us-east-1",
  clusterName: "my-cluster",
  exporters: ["cloudwatch", "xray"],
});
\`\`\`

## Pod Identity vs IRSA

| Feature | IRSA | Pod Identity |
|---------|------|-------------|
| K8s annotation needed | Yes (\`eks.amazonaws.com/role-arn\`) | No |
| Composite available | **IrsaServiceAccount** | None needed |
| Setup | OIDC provider + IAM role trust policy | EKS Pod Identity Agent add-on + association |
| When to use | Existing clusters, broad compatibility | New clusters (EKS 1.28+), simpler management |

For Pod Identity, no K8s-side composite is needed — configure the association via AWS API/CloudFormation and use a plain ServiceAccount.

## Karpenter

Karpenter replaces Cluster Autoscaler for node provisioning. Karpenter NodePool and EC2NodeClass are simple CRDs — use CRD import rather than composites:

\`\`\`bash
# Import Karpenter CRDs into your chant project
chant import --url https://raw.githubusercontent.com/aws/karpenter/main/pkg/apis/crds/karpenter.sh_nodepools.yaml
\`\`\`

## Fargate Considerations

When running on EKS Fargate:
- **No DaemonSets** — FluentBitAgent and AdotCollector cannot run on Fargate nodes
- **No hostPath volumes** — use EFS for shared storage
- **No privileged containers** — security context restrictions apply
- For Fargate logging, use the built-in Fluent Bit log router (Fargate logging configuration)

## EKS Add-ons

Common add-ons managed via AWS (not K8s manifests):
- **vpc-cni** — Amazon VPC CNI plugin
- **coredns** — Cluster DNS
- **kube-proxy** — Network proxy
- **aws-ebs-csi-driver** — EBS CSI driver (required for EbsStorageClass)
- **aws-efs-csi-driver** — EFS CSI driver (required for EfsStorageClass)
- **adot** — AWS Distro for OpenTelemetry (alternative to AdotCollector composite)
- **aws-guardduty-agent** — Runtime threat detection

Configure add-ons via the AWS lexicon (\`@intentius/chant-lexicon-aws\`) CloudFormation resources.
`,
        triggers: [
          { type: "context", value: "eks" },
          { type: "context", value: "irsa" },
          { type: "context", value: "alb" },
          { type: "context", value: "ebs" },
          { type: "context", value: "efs" },
          { type: "context", value: "fluent-bit" },
          { type: "context", value: "cloudwatch" },
          { type: "context", value: "karpenter" },
          { type: "context", value: "fargate" },
        ],
        preConditions: [
          "chant CLI is installed (chant --version succeeds)",
          "EKS cluster is provisioned",
          "kubectl is configured for the EKS cluster",
        ],
        postConditions: [
          "EKS-specific resources are deployed and functional",
        ],
        parameters: [],
        examples: [
          {
            title: "IRSA ServiceAccount",
            description: "Create a ServiceAccount with IAM role for S3 access",
            input: "Create an IRSA ServiceAccount for my app that needs S3 access",
            output: `import { IrsaServiceAccount } from "@intentius/chant-lexicon-k8s";

const { serviceAccount } = IrsaServiceAccount({
  name: "app-sa",
  iamRoleArn: "arn:aws:iam::123456789012:role/app-s3-role",
  namespace: "prod",
});`,
          },
          {
            title: "ALB Ingress with TLS",
            description: "Create an ALB Ingress with ACM certificate",
            input: "Set up an internet-facing ALB with TLS for my API",
            output: `import { AlbIngress } from "@intentius/chant-lexicon-k8s";

const { ingress } = AlbIngress({
  name: "api-ingress",
  hosts: [{ hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] }],
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
});`,
          },
        ],
      },
      {
        name: "chant-k8s-patterns",
        description: "Advanced K8s patterns — sidecars, observability, TLS, network isolation, config/secret mounting",
        content: `---
skill: chant-k8s-patterns
description: Advanced Kubernetes deployment patterns and composites
user-invocable: true
---

# Advanced Kubernetes Patterns

## Sidecar Patterns

### SidecarApp — multi-container Deployment

\`\`\`typescript
import { SidecarApp } from "@intentius/chant-lexicon-k8s";

// Envoy sidecar proxy
const { deployment, service } = SidecarApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  sidecars: [
    {
      name: "envoy",
      image: "envoyproxy/envoy:v1.28",
      ports: [{ containerPort: 9901, name: "admin" }],
      resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "200m", memory: "256Mi" } },
    },
  ],
  initContainers: [
    { name: "migrate", image: "api:1.0", command: ["python", "manage.py", "migrate"] },
  ],
  sharedVolumes: [{ name: "tmp", emptyDir: {} }],
});
\`\`\`

Common sidecar use cases:
- **Envoy proxy** — service mesh, mTLS, traffic management
- **Log forwarder** — Fluent Bit sidecar for app-specific log routing
- **Auth proxy** — OAuth2 Proxy for authentication
- **Config watcher** — reload config on ConfigMap changes

## Config and Secret Mounting

### ConfiguredApp — automatic volume wiring

\`\`\`typescript
import { ConfiguredApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service, configMap } = ConfiguredApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  // Mount ConfigMap as volume
  configData: { "app.conf": "key=value\\nother=setting" },
  configMountPath: "/etc/api",
  // Mount existing Secret as volume
  secretName: "api-creds",
  secretMountPath: "/secrets",
  // Inject as environment variables
  envFrom: { secretRef: "api-env-secret", configMapRef: "api-env-config" },
  // Run migrations before the app starts
  initContainers: [
    { name: "migrate", image: "api:1.0", command: ["./migrate.sh"] },
  ],
});
\`\`\`

### Volume patterns

| Pattern | Use Case | ConfiguredApp Props |
|---------|----------|---------------------|
| ConfigMap as file | Config files, templates | \`configData\` + \`configMountPath\` |
| Secret as file | TLS certs, credentials | \`secretName\` + \`secretMountPath\` |
| ConfigMap as env | Simple key-value config | \`envFrom.configMapRef\` |
| Secret as env | Database URLs, API keys | \`envFrom.secretRef\` |

## TLS / cert-manager

### SecureIngress — multi-host TLS with cert-manager

\`\`\`typescript
import { SecureIngress } from "@intentius/chant-lexicon-k8s";

const { ingress, certificate } = SecureIngress({
  name: "app-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [
        { path: "/v1", serviceName: "api-v1", servicePort: 80 },
        { path: "/v2", serviceName: "api-v2", servicePort: 80 },
      ],
    },
    {
      hostname: "admin.example.com",
      paths: [{ path: "/", serviceName: "admin", servicePort: 80 }],
    },
  ],
  clusterIssuer: "letsencrypt-prod",
  ingressClassName: "nginx",
});
\`\`\`

Features:
- Multiple hosts and paths per Ingress
- Automatic cert-manager Certificate when \`clusterIssuer\` set
- TLS secret auto-provisioned by cert-manager

### cert-manager setup (prerequisite)

\`\`\`bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# Create ClusterIssuer for Let's Encrypt
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
\`\`\`

## Observability

### MonitoredService — Prometheus monitoring

\`\`\`typescript
import { MonitoredService } from "@intentius/chant-lexicon-k8s";

const { deployment, service, serviceMonitor, prometheusRule } = MonitoredService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  metricsPort: 9090,
  metricsPath: "/metrics",
  scrapeInterval: "15s",
  alertRules: [
    {
      name: "HighErrorRate",
      expr: 'rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05',
      for: "5m",
      severity: "critical",
      annotations: { summary: "High error rate on {{ $labels.instance }}" },
    },
    {
      name: "HighLatency",
      expr: 'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 1',
      for: "10m",
      severity: "warning",
    },
  ],
});
\`\`\`

### Prerequisites

- Prometheus Operator installed (for ServiceMonitor/PrometheusRule CRDs)
- Prometheus configured to discover ServiceMonitors

## Network Isolation

### NetworkIsolatedApp — per-app firewall rules

\`\`\`typescript
import { NetworkIsolatedApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service, networkPolicy } = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  allowIngressFrom: [
    { podSelector: { "app.kubernetes.io/name": "frontend" } },
    { namespaceSelector: { "kubernetes.io/metadata.name": "monitoring" } },
  ],
  allowEgressTo: [
    { podSelector: { "app.kubernetes.io/name": "postgres" }, ports: [{ port: 5432 }] },
    { podSelector: { "app.kubernetes.io/name": "redis" }, ports: [{ port: 6379 }] },
  ],
});
\`\`\`

### Combining with NamespaceEnv

Use NamespaceEnv for namespace-level default-deny, then NetworkIsolatedApp for per-app allow rules:

\`\`\`typescript
// Namespace: deny all by default
const ns = NamespaceEnv({ name: "prod", defaultDenyIngress: true, defaultDenyEgress: true });

// App: allow specific traffic
const app = NetworkIsolatedApp({
  name: "api",
  image: "api:1.0",
  namespace: "prod",
  allowIngressFrom: [{ podSelector: { "app.kubernetes.io/name": "gateway" } }],
  allowEgressTo: [{ podSelector: { "app.kubernetes.io/name": "db" }, ports: [{ port: 5432 }] }],
});
\`\`\`

## Blue/Green and Canary

These patterns use standard K8s resources — no special composite needed.

### Blue/Green

\`\`\`typescript
// Two Deployments with different versions
const blue = WebApp({ name: "app-blue", image: "app:1.0", labels: { version: "blue" } });
const green = WebApp({ name: "app-green", image: "app:2.0", labels: { version: "green" } });

// Service points to active version — switch by changing selector
// Active: blue → green (update the Service selector)
\`\`\`

### Canary

\`\`\`typescript
// Main deployment (90% traffic)
const main = AutoscaledService({ name: "app", image: "app:1.0", minReplicas: 9, maxReplicas: 20, ... });

// Canary deployment (10% traffic) — same app label, fewer replicas
const canary = WebApp({ name: "app-canary", image: "app:2.0", replicas: 1, labels: { track: "canary" } });
// Both share the same Service selector ("app.kubernetes.io/name": "app") for traffic splitting
\`\`\`

## Gateway API (future direction)

Gateway API is the successor to Ingress. Key differences:
- **HTTPRoute** replaces Ingress rules
- **Gateway** replaces IngressClass
- Built-in traffic splitting, header matching, URL rewriting
- Currently in beta — use Ingress/SecureIngress/AlbIngress for production today

When Gateway API reaches GA, new composites will be added. For now, use CRD import if you need Gateway API resources.
`,
        triggers: [
          { type: "context", value: "sidecar" },
          { type: "context", value: "init-container" },
          { type: "context", value: "prometheus" },
          { type: "context", value: "cert-manager" },
          { type: "context", value: "tls" },
          { type: "context", value: "network-policy" },
          { type: "context", value: "canary" },
          { type: "context", value: "blue-green" },
          { type: "context", value: "configmap-mount" },
          { type: "context", value: "secret-mount" },
        ],
        preConditions: [
          "chant CLI is installed (chant --version succeeds)",
          "kubectl is configured and can access the cluster",
        ],
        postConditions: [
          "Pattern resources are deployed and functional",
        ],
        parameters: [],
        examples: [
          {
            title: "Sidecar with envoy proxy",
            description: "Deploy an app with an Envoy sidecar",
            input: "Add an envoy sidecar proxy to my API",
            output: `import { SidecarApp } from "@intentius/chant-lexicon-k8s";

const { deployment, service } = SidecarApp({
  name: "api",
  image: "api:1.0",
  port: 8080,
  sidecars: [{ name: "envoy", image: "envoyproxy/envoy:v1.28", ports: [{ containerPort: 9901 }] }],
});`,
          },
          {
            title: "Monitored service with alerts",
            description: "Deploy a service with Prometheus monitoring and alerting",
            input: "Set up monitoring for my API with error rate alerts",
            output: `import { MonitoredService } from "@intentius/chant-lexicon-k8s";

const { deployment, service, serviceMonitor, prometheusRule } = MonitoredService({
  name: "api",
  image: "api:1.0",
  metricsPort: 9090,
  alertRules: [{ name: "HighErrorRate", expr: 'rate(http_errors[5m]) > 0.1', severity: "critical" }],
});`,
          },
        ],
      },
    ];
  },
};
