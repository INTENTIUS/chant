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
    return [
      wk8005, wk8006, wk8041, wk8042,
      wk8101, wk8102, wk8103, wk8104, wk8105,
      wk8201, wk8202, wk8203, wk8204, wk8205, wk8207, wk8208, wk8209,
      wk8301, wk8302, wk8303,
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

### Resource inspection

\`\`\`bash
# Get all resources in namespace
kubectl get all -n <namespace>

# YAML output for debugging
kubectl get deployment/my-app -o yaml

# Check resource usage
kubectl top pods -l app.kubernetes.io/name=my-app
kubectl top nodes
\`\`\`

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

### Rollback

\`\`\`bash
# Check rollout history
kubectl rollout history deployment/my-app

# Undo last rollout
kubectl rollout undo deployment/my-app

# Roll back to a specific revision
kubectl rollout undo deployment/my-app --to-revision=2

# Watch rollout progress
kubectl rollout status deployment/my-app --timeout=300s
\`\`\`

### Deployment strategies

- **RollingUpdate** (default): Gradually replaces pods. Set \`maxSurge\` and \`maxUnavailable\`.
- **Recreate**: All pods terminated before new ones created. Use for stateful apps that cannot run multiple versions.
- **Canary**: Deploy a second Deployment with 1 replica + same selector labels. Route percentage via Ingress annotations or service mesh.
- **Blue/Green**: Two full Deployments (blue/green), switch Service selector between them.

## Namespace management

\`\`\`bash
# Create namespace with resource limits
kubectl create namespace my-project

# Set default resource quotas
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: default-quota
  namespace: my-project
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "20"
EOF

# Set default container limits via LimitRange
kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: my-project
spec:
  limits:
  - default:
      cpu: 500m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
    type: Container
EOF
\`\`\`

## Troubleshooting reference table

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| Pod stuck in Pending | Insufficient CPU/memory on nodes | Scale up cluster or reduce resource requests |
| Pod stuck in Pending | PVC not bound | Check StorageClass exists, PV available |
| Pod stuck in Pending | Node selector/affinity mismatch | Verify node labels match selectors |
| Pod stuck in ContainerCreating | ConfigMap/Secret not found | Ensure referenced ConfigMaps/Secrets exist |
| Pod stuck in ContainerCreating | Volume mount failure | Check PVC status, CSI driver health |
| Service returns 503 | No ready endpoints | Check pod readiness probes, selector match |
| Service returns 503 | Wrong port configuration | Verify targetPort matches containerPort |
| Ingress returns 404 | Backend service not found | Check Ingress rules, service name/port |
| Ingress returns 404 | Wrong path matching | Check pathType (Prefix vs Exact) |
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
        ],
      },
    ];
  },
};
