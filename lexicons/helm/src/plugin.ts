/**
 * Helm lexicon plugin.
 *
 * Implements the LexiconPlugin interface with the Helm chart serializer,
 * Helm-specific intrinsics, lint rules, and post-synth checks.
 */

import { createRequire } from "module";
import type { LexiconPlugin, IntrinsicDef, InitTemplateSet, SkillDefinition } from "@intentius/chant/lexicon";
import type { LintRule } from "@intentius/chant/lint/rule";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { helmSerializer } from "./serializer";

const require = createRequire(import.meta.url);

export const helmPlugin: LexiconPlugin = {
  name: "helm",
  serializer: helmSerializer,

  lintRules(): LintRule[] {
    const { chartMetadataRule } = require("./lint/rules/chart-metadata");
    const { valuesNoSecretsRule } = require("./lint/rules/values-no-secrets");
    const { noHardcodedImageRule } = require("./lint/rules/no-hardcoded-image");
    return [chartMetadataRule, valuesNoSecretsRule, noHardcodedImageRule];
  },

  postSynthChecks(): PostSynthCheck[] {
    const { whm101 } = require("./lint/post-synth/whm101");
    const { whm102 } = require("./lint/post-synth/whm102");
    const { whm103 } = require("./lint/post-synth/whm103");
    const { whm104 } = require("./lint/post-synth/whm104");
    const { whm105 } = require("./lint/post-synth/whm105");
    const { whm201 } = require("./lint/post-synth/whm201");
    const { whm202 } = require("./lint/post-synth/whm202");
    const { whm203 } = require("./lint/post-synth/whm203");
    const { whm204 } = require("./lint/post-synth/whm204");
    const { whm301 } = require("./lint/post-synth/whm301");
    const { whm302 } = require("./lint/post-synth/whm302");
    return [whm101, whm102, whm103, whm104, whm105, whm201, whm202, whm203, whm204, whm301, whm302];
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

  skills(): SkillDefinition[] {
    const skillPath = join(dirname(fileURLToPath(import.meta.url)), "skills", "create-chart.md");
    const content = readFileSync(skillPath, "utf-8");
    return [
      {
        name: "chant-helm",
        description: "Helm chart lifecycle — scaffold, generate, lint, build, validate",
        content,
      },
    ];
  },

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
