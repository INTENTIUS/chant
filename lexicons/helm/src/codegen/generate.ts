/**
 * Helm generation pipeline — static type generation.
 *
 * Unlike AWS/K8s, Helm types are defined statically (no upstream schema to
 * fetch). This module generates lexicon-helm.json, index.d.ts, and index.ts
 * directly from the known Helm resource/property type definitions.
 */

import {
  writeGeneratedArtifacts,
  type GenerateResult,
} from "@intentius/chant/codegen/generate";

// ── Static type definitions ──────────────────────────────

interface HelmTypeEntry {
  resourceType: string;
  kind: "resource" | "property";
  description: string;
  props: Record<string, { type: string; description: string; required?: boolean }>;
}

const HELM_TYPES: HelmTypeEntry[] = [
  {
    resourceType: "Helm::Chart",
    kind: "resource",
    description: "Chart.yaml metadata — defines the chart identity, version, and type.",
    props: {
      apiVersion: { type: "string", description: "Chart API version (v2)", required: true },
      name: { type: "string", description: "Chart name", required: true },
      version: { type: "string", description: "Chart version (SemVer)", required: true },
      appVersion: { type: "string", description: "Version of the app deployed by this chart" },
      description: { type: "string", description: "A single-sentence description of this chart" },
      type: { type: "string", description: "Chart type: application or library" },
      keywords: { type: "string[]", description: "Keywords for chart search" },
      home: { type: "string", description: "URL of the project home page" },
      icon: { type: "string", description: "URL to an SVG or PNG image for the chart" },
      deprecated: { type: "boolean", description: "Whether this chart is deprecated" },
      sources: { type: "string[]", description: "URLs to source code for this chart" },
      maintainers: { type: "Maintainer[]", description: "List of chart maintainers" },
      annotations: { type: "Record<string, string>", description: "Arbitrary key-value annotations" },
      kubeVersion: { type: "string", description: "SemVer range of compatible Kubernetes versions" },
      condition: { type: "string", description: "YAML path for chart enablement (subcharts)" },
      tags: { type: "string", description: "Tags for grouping charts for enabling/disabling" },
    },
  },
  {
    resourceType: "Helm::Values",
    kind: "resource",
    description: "Typed values definition — emits values.yaml and values.schema.json.",
    props: {},
  },
  {
    resourceType: "Helm::Test",
    kind: "resource",
    description: "Helm test pod — annotated with helm.sh/hook: test.",
    props: {
      resource: { type: "object", description: "K8s Pod resource to use as the test" },
    },
  },
  {
    resourceType: "Helm::Notes",
    kind: "resource",
    description: "NOTES.txt template content — displayed after helm install.",
    props: {
      content: { type: "string", description: "NOTES.txt content (may contain Go template expressions)", required: true },
    },
  },
  {
    resourceType: "Helm::Hook",
    kind: "property",
    description: "Lifecycle hook annotation — wraps a K8s resource with helm.sh/hook annotations.",
    props: {
      hook: { type: "string", description: "Hook type: pre-install, post-install, pre-upgrade, post-upgrade, pre-delete, post-delete, pre-rollback, post-rollback, test", required: true },
      weight: { type: "number", description: "Hook execution order weight" },
      deletePolicy: { type: "string", description: "Hook delete policy: before-hook-creation, hook-succeeded, hook-failed" },
      resource: { type: "object", description: "K8s resource to annotate with the hook", required: true },
    },
  },
  {
    resourceType: "Helm::Dependency",
    kind: "property",
    description: "Chart dependency entry for Chart.yaml dependencies.",
    props: {
      name: { type: "string", description: "Dependency chart name", required: true },
      version: { type: "string", description: "Dependency version range (SemVer)", required: true },
      repository: { type: "string", description: "Repository URL", required: true },
      condition: { type: "string", description: "YAML path that enables/disables this dependency" },
      tags: { type: "string[]", description: "Tags for grouping dependencies" },
      enabled: { type: "boolean", description: "Whether this dependency is enabled" },
      importValues: { type: "unknown[]", description: "Values to import from dependency (import-values in Chart.yaml)" },
      alias: { type: "string", description: "Alias for the dependency" },
    },
  },
  {
    resourceType: "Helm::Maintainer",
    kind: "property",
    description: "Chart maintainer entry for Chart.yaml maintainers.",
    props: {
      name: { type: "string", description: "Maintainer name", required: true },
      email: { type: "string", description: "Maintainer email" },
      url: { type: "string", description: "Maintainer URL" },
    },
  },
  {
    resourceType: "Helm::CRD",
    kind: "resource",
    description: "Custom Resource Definition — placed in the crds/ directory.",
    props: {
      content: { type: "string", description: "CRD YAML content", required: true },
      filename: { type: "string", description: "CRD filename (e.g. mycrd.yaml)" },
    },
  },
];

// ── Generate artifacts ──────────────────────────────────

function generateLexiconJSON(): string {
  const registry: Record<string, Record<string, unknown>> = {};
  for (const t of HELM_TYPES) {
    const shortName = t.resourceType.split("::").pop()!;
    registry[shortName] = {
      resourceType: t.resourceType,
      kind: t.kind,
      description: t.description,
      props: t.props,
    };
  }
  return JSON.stringify(registry, null, 2);
}

function generateTypesDTS(): string {
  const lines: string[] = [
    '// Auto-generated Helm lexicon type declarations',
    '// Do not edit manually',
    '',
    'import type { Declarable } from "@intentius/chant/declarable";',
    '',
  ];

  for (const t of HELM_TYPES) {
    const className = t.resourceType.split("::").pop()!;
    const propsInterface = `${className}Props`;

    // Generate props interface
    lines.push(`/** ${t.description} */`);
    lines.push(`export interface ${propsInterface} {`);
    for (const [key, prop] of Object.entries(t.props)) {
      const optional = prop.required ? "" : "?";
      lines.push(`  /** ${prop.description} */`);
      lines.push(`  ${key}${optional}: ${prop.type};`);
    }
    if (Object.keys(t.props).length === 0) {
      lines.push("  [key: string]: unknown;");
    }
    lines.push("}");
    lines.push("");

    // Generate class declaration
    lines.push(`/** ${t.description} */`);
    lines.push(`export declare const ${className}: new (props: ${propsInterface}) => Declarable;`);
    lines.push("");
  }

  return lines.join("\n");
}

function generateRuntimeIndex(): string {
  const lines: string[] = [
    '// Auto-generated Helm lexicon runtime index',
    '// Do not edit manually',
    '',
    'import { createResource, createProperty } from "@intentius/chant/runtime";',
    '',
  ];

  for (const t of HELM_TYPES) {
    const className = t.resourceType.split("::").pop()!;
    if (t.kind === "resource") {
      lines.push(`export const ${className} = createResource("${t.resourceType}", "helm", {});`);
    } else {
      lines.push(`export const ${className} = createProperty("${t.resourceType}", "helm");`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ── Public API ──────────────────────────────────────────

export interface HelmGenerateOptions {
  verbose?: boolean;
  force?: boolean;
}

/**
 * Run the Helm generation pipeline.
 * Since Helm types are static, this doesn't fetch anything.
 */
export async function generate(opts: HelmGenerateOptions = {}): Promise<GenerateResult> {
  const log = opts.verbose
    ? (msg: string) => console.error(msg)
    : (_msg: string) => {};

  log("Generating Helm lexicon (static types)...");

  const lexiconJSON = generateLexiconJSON();
  const typesDTS = generateTypesDTS();
  const indexTS = generateRuntimeIndex();

  const resourceCount = HELM_TYPES.filter((t) => t.kind === "resource").length;
  const propertyCount = HELM_TYPES.filter((t) => t.kind === "property").length;

  log(`Generated ${resourceCount} resources, ${propertyCount} property types`);

  return {
    lexiconJSON,
    typesDTS,
    indexTS,
    resources: resourceCount,
    properties: propertyCount,
    enums: 0,
    warnings: [],
  };
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-helm.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
    },
  });
}
