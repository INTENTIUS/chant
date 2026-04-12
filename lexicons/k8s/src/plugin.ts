/**
 * Kubernetes lexicon plugin.
 *
 * Provides serializer, template detection, code generation,
 * lint rules, and LSP/MCP integration for Kubernetes manifests.
 */

import type { LexiconPlugin, InitTemplateSet, ResourceMetadata } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import { discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool, createCatalogResource } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { k8sSerializer } from "./serializer";
import { hardcodedNamespaceRule } from "./lint/rules/hardcoded-namespace";
import { latestImageTagRule } from "./lint/rules/latest-image-tag";
import { missingResourceLimitsRule } from "./lint/rules/missing-resource-limits";
import { k8sCompletions } from "./lsp/completions";
import { k8sHover } from "./lsp/hover";
import { K8sParser } from "./import/parser";
import { K8sGenerator } from "./import/generator";

export const k8sPlugin: LexiconPlugin = {
  name: "k8s",
  serializer: k8sSerializer,

  lintRules(): LintRule[] {
    return [hardcodedNamespaceRule, latestImageTagRule, missingResourceLimitsRule];
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
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
    return k8sCompletions(ctx);
  },

  hoverProvider(ctx: import("@intentius/chant/lsp/types").HoverContext) {
    return k8sHover(ctx);
  },

  templateParser() {
    return new K8sParser();
  },

  templateGenerator() {
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

  async describeResources(options: {
    environment: string;
    buildOutput: string;
    entityNames: string[];
  }): Promise<Record<string, ResourceMetadata>> {
    const { getRuntime } = await import("@intentius/chant/runtime-adapter");
    const rt = getRuntime();
    const resources: Record<string, ResourceMetadata> = {};

    // Resolve namespace from environment (convention: env name = namespace)
    const namespace = options.environment;

    // Parse build output to extract kind/name pairs for each entity
    let manifests: Array<{ kind: string; metadata: { name: string; namespace?: string }; apiVersion: string }> = [];
    try {
      // K8s build output is YAML with --- separators
      const docs = options.buildOutput.split(/^---$/m).filter((d) => d.trim());
      for (const doc of docs) {
        // Simple YAML parsing — look for kind: and metadata.name:
        const kindMatch = doc.match(/^kind:\s*(.+)$/m);
        const nameMatch = doc.match(/^\s+name:\s*(.+)$/m);
        const apiVersionMatch = doc.match(/^apiVersion:\s*(.+)$/m);
        if (kindMatch && nameMatch && apiVersionMatch) {
          manifests.push({
            kind: kindMatch[1].trim(),
            metadata: { name: nameMatch[1].trim() },
            apiVersion: apiVersionMatch[1].trim(),
          });
        }
      }
    } catch {
      // If build output parsing fails, skip
    }

    // Query each resource
    for (const entityName of options.entityNames) {
      // Find the corresponding manifest
      const manifest = manifests.find((m) => {
        // Try matching by entity name convention
        return m.metadata.name === entityName ||
          entityName.toLowerCase().includes(m.metadata.name.toLowerCase());
      });

      if (!manifest) continue;

      // Build kubectl resource type from apiVersion + kind
      const resourceType = manifest.kind.toLowerCase();
      const getResult = await rt.spawn([
        "kubectl", "get", resourceType, manifest.metadata.name,
        "-n", namespace,
        "-o", "json",
      ]);

      if (getResult.exitCode !== 0) continue;

      try {
        const obj = JSON.parse(getResult.stdout) as {
          metadata: { name: string; uid: string; creationTimestamp: string };
          status?: { phase?: string; conditions?: Array<{ type: string; status: string }> };
        };

        // Derive status from conditions or phase
        let status = "Unknown";
        if (obj.status?.phase) {
          status = obj.status.phase;
        } else if (obj.status?.conditions) {
          const ready = obj.status.conditions.find((c) => c.type === "Ready" || c.type === "Available");
          status = ready?.status === "True" ? "Ready" : "NotReady";
        }

        // Build attributes, scrubbing sensitive data
        const attributes: Record<string, unknown> = {
          uid: obj.metadata.uid,
        };

        resources[entityName] = {
          type: `${manifest.apiVersion}/${manifest.kind}`,
          physicalId: obj.metadata.name,
          status,
          lastUpdated: obj.metadata.creationTimestamp,
          attributes,
        };
      } catch {
        // Skip parse failures
      }
    }

    return resources;
  },

  mcpTools() {
    return [createDiffTool(k8sSerializer, "Compare current build output against previous output for Kubernetes manifests")];
  },

  mcpResources() {
    return [
      createCatalogResource(import.meta.url, "Kubernetes Resource Catalog", "JSON list of all supported Kubernetes resource types", "lexicon-k8s.json"),
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

  skills: createSkillsLoader(import.meta.url, [
      {
        file: "chant-k8s.md",
        name: "chant-k8s",
        description: "Kubernetes manifest lifecycle — scaffold, generate, lint, build, apply, troubleshoot, rollback",
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
        file: "chant-k8s-patterns.md",
        name: "chant-k8s-patterns",
        description: "Advanced K8s patterns — sidecars, observability, TLS, network isolation, config/secret mounting",
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
      {
        file: "chant-k8s-deployment-strategies.md",
        name: "chant-k8s-deployment-strategies",
        description: "Kubernetes deployment strategies, stateful workloads, RBAC, and networking patterns",
        triggers: [
          { type: "context", value: "deployment strategy" },
          { type: "context", value: "statefulset" },
          { type: "context", value: "rbac" },
          { type: "context", value: "network policy" },
          { type: "context", value: "rolling update" },
          { type: "context", value: "blue green" },
        ],
        parameters: [],
        examples: [
          {
            title: "Blue/Green Deployment",
            input: "Set up a blue/green deployment for my app",
            output: "import { WebApp } from \"@intentius/chant-lexicon-k8s\";\n\nconst blue = WebApp({ name: \"app-blue\", image: \"app:1.0\" });\nconst green = WebApp({ name: \"app-green\", image: \"app:2.0\" });",
          },
        ],
      },
      {
        file: "chant-k8s-security.md",
        name: "chant-k8s-security",
        description: "Kubernetes pod security, image scanning, network policies, and secrets management",
        triggers: [
          { type: "context", value: "k8s security" },
          { type: "context", value: "pod security" },
          { type: "context", value: "image security" },
          { type: "context", value: "k8s secrets" },
          { type: "context", value: "security context" },
        ],
        parameters: [],
        examples: [
          {
            title: "Hardened Container",
            input: "Create a hardened container with security context",
            output: "WebApp({ name: \"api\", image: \"api:1.0\", securityContext: { runAsNonRoot: true, readOnlyRootFilesystem: true, capabilities: { drop: [\"ALL\"] } } })",
          },
        ],
      },
      {
        file: "chant-k8s-eks.md",
        name: "chant-k8s-eks",
        description: "EKS-specific Kubernetes composites — IRSA, ALB, EBS/EFS, Fluent Bit, ExternalDNS, ADOT",
        triggers: [
          { type: "context", value: "eks composites" },
          { type: "context", value: "irsa" },
          { type: "context", value: "alb ingress" },
          { type: "context", value: "ebs storage" },
          { type: "context", value: "karpenter" },
        ],
        parameters: [],
        examples: [
          {
            title: "IRSA ServiceAccount",
            input: "Create an IRSA ServiceAccount for my app",
            output: "import { IrsaServiceAccount } from \"@intentius/chant-lexicon-k8s\";\n\nconst { serviceAccount } = IrsaServiceAccount({ name: \"app-sa\", iamRoleArn: \"arn:aws:iam::123456789012:role/app-role\" });",
          },
        ],
      },
      {
        file: "chant-k8s-gke.md",
        name: "chant-k8s-gke",
        description: "GKE-specific Kubernetes composites — Workload Identity, GCE PD, Filestore, FluentBit, OTel, ExternalDNS, Gateway",
        triggers: [
          { type: "context", value: "gke composites" },
          { type: "context", value: "workload identity gke" },
          { type: "context", value: "config connector k8s" },
        ],
        parameters: [],
        examples: [
          {
            title: "GKE Workload Identity",
            input: "Create a ServiceAccount with GKE Workload Identity",
            output: "import { WorkloadIdentityServiceAccount } from \"@intentius/chant-lexicon-k8s\";\n\nconst { serviceAccount } = WorkloadIdentityServiceAccount({ name: \"app-sa\", gcpServiceAccountEmail: \"app@project.iam.gserviceaccount.com\" });",
          },
        ],
      },
      {
        file: "chant-k8s-aks.md",
        name: "chant-k8s-aks",
        description: "AKS-specific Kubernetes composites — Workload Identity, AGIC, Azure Disk/File, ExternalDNS, Azure Monitor",
        triggers: [
          { type: "context", value: "aks composites" },
          { type: "context", value: "workload identity aks" },
          { type: "context", value: "agic ingress" },
        ],
        parameters: [],
        examples: [
          {
            title: "AKS Workload Identity",
            input: "Create a ServiceAccount with AKS Workload Identity",
            output: "import { AksWorkloadIdentityServiceAccount } from \"@intentius/chant-lexicon-k8s\";\n\nconst { serviceAccount } = AksWorkloadIdentityServiceAccount({ name: \"app-sa\", clientId: \"12345678-abcd-1234-abcd-123456789012\" });",
          },
        ],
      },
    ]),
};
