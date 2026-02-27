/**
 * GCP Config Connector generation pipeline — uses core generatePipeline
 * with GCP-specific fetch, parse, naming, and generation callbacks.
 */

import {
  generatePipeline,
  writeGeneratedArtifacts,
  type GenerateOptions,
  type GenerateResult,
  type GeneratePipelineConfig,
} from "@intentius/chant/codegen/generate";
import { fetchCRDBundle } from "../spec/fetch";
import { parseGcpCRD, gcpShortName, type GcpParseResult } from "../spec/parse";
import { NamingStrategy, propertyTypeName, extractDefName } from "./naming";
import {
  generateRuntimeIndex as coreGenerateRuntimeIndex,
  type RuntimeIndexEntry,
  type RuntimeIndexPropertyEntry,
} from "@intentius/chant/codegen/generate-runtime-index";

export type { GenerateOptions, GenerateResult };

const gcpPipelineConfig: GeneratePipelineConfig<GcpParseResult> = {
  fetchSchemas: async (opts) => {
    return fetchCRDBundle(opts.force);
  },

  parseSchema: (_typeName, data) => {
    const results = parseGcpCRD(data);
    // Each CRD file may contain one or more resources
    // We return the first one; additional ones get collected in augmentResults
    if (results.length === 0) return null;
    return results[0];
  },

  createNaming: (results) => new NamingStrategy(results),

  augmentResults: (results, _opts, log) => {
    const warnings: Array<{ file: string; error: string }> = [];
    log(`Total: ${results.length} GCP Config Connector resource schemas`);
    return { results, warnings };
  },

  generateRegistry: (results, naming) => {
    return generateLexiconJSON(results, naming as NamingStrategy);
  },

  generateTypes: (results, naming) => {
    return generateTypeScriptDeclarations(results, naming as NamingStrategy);
  },

  generateRuntimeIndex: (results, naming) => {
    return generateRuntimeIndex(results, naming as NamingStrategy);
  },
};

/**
 * Run the full GCP generation pipeline.
 */
export async function generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
  return generatePipeline(gcpPipelineConfig, opts);
}

/**
 * Write generated artifacts to disk.
 */
export function writeGeneratedFiles(result: GenerateResult, baseDir: string): void {
  writeGeneratedArtifacts({
    baseDir,
    files: {
      "lexicon-gcp.json": result.lexiconJSON,
      "index.d.ts": result.typesDTS,
      "index.ts": result.indexTS,
      "runtime.ts": [
        "/**",
        " * Runtime factory constructors — re-exported from core.",
        " */",
        'export { createResource, createProperty } from "@intentius/chant/runtime";',
        "",
      ].join("\n"),
    },
  });
}

// ── Lexicon JSON generation ─────────────────────────────────────────

function generateLexiconJSON(results: GcpParseResult[], naming: NamingStrategy): string {
  const entries: Record<string, unknown> = {};

  for (const r of results) {
    const cfnType = r.resource.typeName;
    const tsName = naming.resolve(cfnType);
    if (!tsName) continue;

    const apiVersion = `${r.gvk.group}/${r.gvk.version}`;

    entries[tsName] = {
      resourceType: cfnType,
      kind: "resource",
      apiVersion,
      gvkKind: r.gvk.kind,
      group: r.gvk.group,
      properties: r.resource.properties.length,
      attrs: Object.fromEntries(
        r.resource.attributes.map((a) => [a.name, a.tsType]),
      ),
    };

    // Add property types
    const shortName = gcpShortName(cfnType);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      entries[ptName] = {
        resourceType: `${cfnType}.${pt.specType}`,
        kind: "property",
      };
    }
  }

  return JSON.stringify(entries, null, 2);
}

// ── TypeScript declarations generation ──────────────────────────────

function generateTypeScriptDeclarations(results: GcpParseResult[], naming: NamingStrategy): string {
  const lines: string[] = [
    "/**",
    " * GCP Config Connector resource type declarations.",
    " *",
    " * Auto-generated — do not edit.",
    " */",
    "",
    'import { createResource, createProperty } from "./runtime";',
    "",
  ];

  for (const r of results) {
    const cfnType = r.resource.typeName;
    const tsName = naming.resolve(cfnType);
    if (!tsName) continue;

    // Resource class interface
    lines.push(`/** ${r.resource.description ?? cfnType} */`);
    lines.push(`export declare class ${tsName} {`);
    lines.push(`  constructor(props: ${tsName}Props);`);

    // Attributes
    for (const attr of r.resource.attributes) {
      lines.push(`  readonly ${attr.name}: ${attr.tsType};`);
    }

    lines.push(`}`);
    lines.push("");

    // Props interface
    lines.push(`export interface ${tsName}Props {`);
    for (const prop of r.resource.properties) {
      const optional = prop.required ? "" : "?";
      const desc = prop.description ? `  /** ${prop.description} */\n` : "";
      lines.push(`${desc}  ${prop.name}${optional}: ${prop.tsType};`);
    }
    lines.push(`}`);
    lines.push("");

    // Aliases
    for (const alias of naming.aliases(cfnType)) {
      lines.push(`/** Alias for ${tsName} */`);
      lines.push(`export declare const ${alias}: typeof ${tsName};`);
      lines.push("");
    }

    // Property types
    const shortName = gcpShortName(cfnType);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);

      lines.push(`export declare class ${ptName} {`);
      lines.push(`  constructor(props: ${ptName}Props);`);
      lines.push(`}`);
      lines.push("");

      lines.push(`export interface ${ptName}Props {`);
      for (const prop of pt.properties) {
        const optional = prop.required ? "" : "?";
        lines.push(`  ${prop.name}${optional}: ${prop.tsType};`);
      }
      lines.push(`}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Runtime index generation ────────────────────────────────────────

function generateRuntimeIndex(results: GcpParseResult[], naming: NamingStrategy): string {
  const resourceEntries: RuntimeIndexEntry[] = [];
  const propertyEntries: RuntimeIndexPropertyEntry[] = [];

  for (const r of results) {
    const cfnType = r.resource.typeName;
    const tsName = naming.resolve(cfnType);
    if (!tsName) continue;

    const attrs: Record<string, string> = {};
    for (const a of r.resource.attributes) {
      attrs[a.name] = a.name;
    }

    resourceEntries.push({ tsName, resourceType: cfnType, attrs });

    for (const alias of naming.aliases(cfnType)) {
      resourceEntries.push({ tsName: alias, resourceType: cfnType, attrs });
    }

    const shortName = gcpShortName(cfnType);
    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptCfnType = `${cfnType}.${pt.specType}`;
      propertyEntries.push({ tsName: ptName, resourceType: ptCfnType });
    }
  }

  return coreGenerateRuntimeIndex(resourceEntries, propertyEntries, {
    lexiconName: "gcp",
    pseudoReExports: {
      names: ["GCP", "ProjectId", "Region", "Zone"],
      from: "../pseudo",
    },
  });
}
