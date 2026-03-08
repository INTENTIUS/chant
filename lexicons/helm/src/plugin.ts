/**
 * Helm lexicon plugin.
 *
 * Implements the LexiconPlugin interface with the Helm chart serializer,
 * Helm-specific intrinsics, lint rules, and post-synth checks.
 */

import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import { discoverLintRules, discoverPostSynthChecks } from "@intentius/chant/lint/discover";
import { createSkillsLoader, createDiffTool } from "@intentius/chant/lexicon-plugin-helpers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { helmSerializer } from "./serializer";

export const helmPlugin: LexiconPlugin = {
  name: "helm",
  serializer: helmSerializer,

  lintRules() {
    const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "rules");
    return discoverLintRules(rulesDir, import.meta.url);
  },

  postSynthChecks() {
    const postSynthDir = join(dirname(fileURLToPath(import.meta.url)), "lint", "post-synth");
    return discoverPostSynthChecks(postSynthDir, import.meta.url);
  },

  intrinsics(): IntrinsicDef[] {
    return [
      { name: "values", description: "Proxy accessor for {{ .Values.x }} references" },
      { name: "Release", description: "Built-in Release object (Name, Namespace, etc.)" },
      { name: "ChartRef", description: "Built-in Chart object (Name, Version, AppVersion)" },
      { name: "include", description: 'Include a named template: {{ include "name" . }}' },
      { name: "required", description: 'Require a value: {{ required "msg" .Values.x }}' },
      { name: "helmDefault", description: 'Default value: {{ default "def" .Values.x }}' },
      { name: "toYaml", description: "Convert to YAML: {{ toYaml .Values.x | nindent N }}" },
      { name: "quote", description: "Quote a value: {{ .Values.x | quote }}" },
      { name: "printf", description: 'Format string: {{ printf "%s" .Values.x }}' },
      { name: "tpl", description: "Evaluate template: {{ tpl .Values.x . }}" },
      { name: "lookup", description: 'Lookup resource: {{ lookup "v1" "Secret" "ns" "name" }}' },
      { name: "Capabilities", description: "Built-in Capabilities object (KubeVersion, APIVersions, HelmVersion)" },
      { name: "Template", description: "Built-in Template object (Name, BasePath)" },
      { name: "filesGet", description: '.Files.Get: {{ .Files.Get "path" }}' },
      { name: "filesGlob", description: '.Files.Glob: {{ .Files.Glob "pattern" }}' },
      { name: "filesAsConfig", description: ".Files.Glob.AsConfig for ConfigMap data" },
      { name: "filesAsSecrets", description: ".Files.Glob.AsSecrets for Secret data" },
      { name: "ElseIf", description: "Else-if chaining: {{- else if .Values.x }}...{{- end }}" },
      { name: "If", description: "Conditional: {{- if .Values.x }}...{{- end }}" },
      { name: "Range", description: "Range loop: {{- range .Values.x }}...{{- end }}" },
      { name: "With", description: "With scope: {{- with .Values.x }}...{{- end }}" },
      { name: "withOrder", description: "Helm hook annotations for resource ordering (pre-install/pre-upgrade)" },
      { name: "argoWave", description: "Argo CD sync wave annotation" },
    ];
  },

  detectTemplate(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    const obj = data as Record<string, unknown>;
    // Helm charts have apiVersion: v2 in Chart.yaml
    if (obj.apiVersion === "v2" && typeof obj.name === "string" && typeof obj.version === "string") {
      return true;
    }
    return false;
  },

  mcpTools() {
    return [createDiffTool(helmSerializer, "Compare current Helm chart build output against previous output")];
  },

  mcpResources() {
    return [
      {
        uri: "resource-catalog",
        name: "Helm Chart Resource Catalog",
        description: "JSON list of all supported Helm chart resource types",
        mimeType: "application/json",
        async handler(): Promise<string> {
          const { readFileSync } = await import("fs");
          const { join, dirname } = await import("path");
          const { fileURLToPath } = await import("url");
          const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
          try {
            const lexicon = JSON.parse(readFileSync(join(pkgDir, "dist", "meta.json"), "utf-8")) as Record<string, { resourceType: string; kind: string }>;
            const entries = Object.entries(lexicon).map(([className, entry]) => ({
              className,
              resourceType: entry.resourceType,
              kind: entry.kind,
            }));
            return JSON.stringify(entries);
          } catch {
            return JSON.stringify([{ className: "Chart", kind: "resource" }, { className: "Values", kind: "resource" }, { className: "HelmNotes", kind: "resource" }]);
          }
        },
      },
      {
        uri: "examples/web-app",
        name: "Web App Helm Chart Example",
        description: "A basic web application Helm chart with Deployment, Service, and Ingress",
        mimeType: "text/typescript",
        async handler(): Promise<string> {
          return `import { Chart, Values, HelmNotes } from "@intentius/chant-lexicon-helm";
import { values, Release, include, toYaml, printf } from "@intentius/chant-lexicon-helm/intrinsics";
import { Deployment, Service, Ingress } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "web-app",
  version: "0.1.0",
  appVersion: "1.0.0",
  type: "application",
  description: "A web application chart",
});

export const valuesSchema = new Values({
  replicaCount: 2,
  image: { repository: "nginx", tag: "latest", pullPolicy: "IfNotPresent" },
  service: { type: "ClusterIP", port: 80 },
  ingress: { enabled: false, host: "example.com" },
});

export const deployment = new Deployment({
  metadata: { name: include("web-app.fullname"), labels: include("web-app.labels") },
  spec: {
    replicas: values.replicaCount,
    selector: { matchLabels: include("web-app.selectorLabels") },
    template: {
      metadata: { labels: include("web-app.selectorLabels") },
      spec: {
        containers: [{
          name: "web-app",
          image: printf("%s:%s", values.image.repository, values.image.tag),
          ports: [{ containerPort: values.service.port, name: "http" }],
        }],
      },
    },
  },
});

export const service = new Service({
  metadata: { name: include("web-app.fullname"), labels: include("web-app.labels") },
  spec: {
    type: values.service.type,
    ports: [{ port: values.service.port, targetPort: "http", protocol: "TCP", name: "http" }],
    selector: include("web-app.selectorLabels"),
  },
});
`;
        },
      },
    ];
  },

  initTemplates(_template?: string): InitTemplateSet {
    if (_template === "stateful-service") {
      return {
        src: {
          "chart.ts": `import { Chart, Values, HelmNotes } from "@intentius/chant-lexicon-helm";
import { values, Release, include, toYaml, printf } from "@intentius/chant-lexicon-helm/intrinsics";
import { StatefulSet, Service, PersistentVolumeClaim, ConfigMap } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "my-stateful-app",
  version: "0.1.0",
  appVersion: "1.0.0",
  type: "application",
  description: "A Helm chart for a stateful application",
});

export const valuesSchema = new Values({
  replicaCount: 3,
  image: {
    repository: "postgres",
    tag: "16",
    pullPolicy: "IfNotPresent",
  },
  service: {
    port: 5432,
  },
  storage: {
    size: "10Gi",
    storageClass: "",
  },
  config: {
    maxConnections: "100",
    sharedBuffers: "256MB",
  },
});

export const configMap = new ConfigMap({
  metadata: {
    name: include("my-stateful-app.fullname"),
    labels: include("my-stateful-app.labels"),
  },
  data: {
    "max_connections": values.config.maxConnections,
    "shared_buffers": values.config.sharedBuffers,
  },
});

export const headlessService = new Service({
  metadata: {
    name: printf("%s-headless", include("my-stateful-app.fullname")),
    labels: include("my-stateful-app.labels"),
  },
  spec: {
    type: "ClusterIP",
    clusterIP: "None",
    ports: [{ port: values.service.port, targetPort: "db", protocol: "TCP", name: "db" }],
    selector: include("my-stateful-app.selectorLabels"),
  },
});

export const statefulSet = new StatefulSet({
  metadata: {
    name: include("my-stateful-app.fullname"),
    labels: include("my-stateful-app.labels"),
  },
  spec: {
    serviceName: printf("%s-headless", include("my-stateful-app.fullname")),
    replicas: values.replicaCount,
    selector: { matchLabels: include("my-stateful-app.selectorLabels") },
    template: {
      metadata: { labels: include("my-stateful-app.selectorLabels") },
      spec: {
        containers: [{
          name: "db",
          image: printf("%s:%s", values.image.repository, values.image.tag),
          ports: [{ containerPort: values.service.port, name: "db" }],
          volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
        }],
      },
    },
    volumeClaimTemplates: [
      new PersistentVolumeClaim({
        metadata: { name: "data" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: values.storage.size } },
        },
      }),
    ],
  },
});
`,
        },
      };
    }

    return {
      src: {
        "chart.ts": `import { Chart, Values, HelmNotes } from "@intentius/chant-lexicon-helm";
import { values, Release, include, toYaml, printf } from "@intentius/chant-lexicon-helm/intrinsics";
import { Deployment, Service } from "@intentius/chant-lexicon-k8s";

export const chart = new Chart({
  apiVersion: "v2",
  name: "my-app",
  version: "0.1.0",
  appVersion: "1.0.0",
  type: "application",
  description: "A Helm chart for my application",
});

export const valuesSchema = new Values({
  replicaCount: 1,
  image: {
    repository: "nginx",
    tag: "",
    pullPolicy: "IfNotPresent",
  },
  service: {
    type: "ClusterIP",
    port: 80,
  },
});

export const deployment = new Deployment({
  metadata: {
    name: include("my-app.fullname"),
    labels: include("my-app.labels"),
  },
  spec: {
    replicas: values.replicaCount,
    selector: {
      matchLabels: include("my-app.selectorLabels"),
    },
    template: {
      metadata: {
        labels: include("my-app.selectorLabels"),
      },
      spec: {
        containers: [{
          name: "my-app",
          image: printf("%s:%s", values.image.repository, values.image.tag),
          ports: [{ containerPort: values.service.port, name: "http" }],
        }],
      },
    },
  },
});

export const service = new Service({
  metadata: {
    name: include("my-app.fullname"),
    labels: include("my-app.labels"),
  },
  spec: {
    type: values.service.type,
    ports: [{
      port: values.service.port,
      targetPort: "http",
      protocol: "TCP",
      name: "http",
    }],
    selector: include("my-app.selectorLabels"),
  },
});
`,
      },
    };
  },

  skills: createSkillsLoader(import.meta.url, [
    { file: "chant-helm.md", name: "chant-helm", description: "Build, validate, and package Helm charts from a chant project" },
    { file: "chant-helm-patterns.md", name: "chant-helm-patterns", description: "Common Helm chart patterns and best practices using chant" },
    { file: "chant-helm-security.md", name: "chant-helm-security", description: "Security best practices for Helm charts built with chant" },
  ]),

  async docs(options?: { verbose?: boolean }): Promise<void> {
    const { generateDocs } = await import("./codegen/docs");
    await generateDocs({ verbose: options?.verbose });
  },

  async generate(options?: { verbose?: boolean }): Promise<void> {
    const { generate, writeGeneratedFiles } = await import("./codegen/generate");
    const { dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const result = await generate({ verbose: options?.verbose ?? true });
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    writeGeneratedFiles(result, pkgDir);

    console.error(`Generated ${result.resources} resources, ${result.properties} property types`);
  },

  async validate(options?: { verbose?: boolean }): Promise<void> {
    const { validate } = await import("./validate");
    const { printValidationResult } = await import("@intentius/chant/codegen/validate");
    const result = await validate();
    printValidationResult(result);
  },

  async coverage(options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    const { analyzeHelmCoverage } = await import("./coverage");
    await analyzeHelmCoverage({
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
};
