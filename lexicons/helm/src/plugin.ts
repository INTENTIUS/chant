/**
 * Helm lexicon plugin.
 *
 * Implements the LexiconPlugin interface with the Helm chart serializer
 * and Helm-specific intrinsics. Lifecycle methods (generate, validate,
 * coverage, package) are stubbed for Phase 1 and will be implemented
 * in Phase 3.
 */

import type { LexiconPlugin, IntrinsicDef, InitTemplateSet } from "@intentius/chant/lexicon";
import { helmSerializer } from "./serializer";

export const helmPlugin: LexiconPlugin = {
  name: "helm",
  serializer: helmSerializer,

  intrinsics(): IntrinsicDef[] {
    return [
      { name: "values", description: "Proxy accessor for {{ .Values.x }} references" },
      { name: "Release", description: "Built-in Release object (Name, Namespace, etc.)" },
      { name: "ChartRef", description: "Built-in Chart object (Name, Version, AppVersion)" },
      { name: "include", description: "Include a named template: {{ include \"name\" . }}" },
      { name: "required", description: "Require a value: {{ required \"msg\" .Values.x }}" },
      { name: "helmDefault", description: "Default value: {{ default \"def\" .Values.x }}" },
      { name: "toYaml", description: "Convert to YAML: {{ toYaml .Values.x | nindent N }}" },
      { name: "quote", description: "Quote a value: {{ .Values.x | quote }}" },
      { name: "printf", description: "Format string: {{ printf \"%s\" .Values.x }}" },
      { name: "tpl", description: "Evaluate template: {{ tpl .Values.x . }}" },
      { name: "lookup", description: "Lookup resource: {{ lookup \"v1\" \"Secret\" \"ns\" \"name\" }}" },
      { name: "If", description: "Conditional: {{- if .Values.x }}...{{- end }}" },
      { name: "Range", description: "Range loop: {{- range .Values.x }}...{{- end }}" },
      { name: "With", description: "With scope: {{- with .Values.x }}...{{- end }}" },
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

  initTemplates(_template?: string): InitTemplateSet {
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

  async generate(_options?: { verbose?: boolean }): Promise<void> {
    console.error("Helm lexicon: generate is a no-op (static types, no upstream schema)");
  },

  async validate(_options?: { verbose?: boolean }): Promise<void> {
    console.error("Helm lexicon: validate stub (Phase 3)");
  },

  async coverage(_options?: { verbose?: boolean; minOverall?: number }): Promise<void> {
    console.error("Helm lexicon: coverage stub (Phase 3)");
  },

  async package(_options?: { verbose?: boolean; force?: boolean }): Promise<void> {
    console.error("Helm lexicon: package stub (Phase 3)");
  },
};
