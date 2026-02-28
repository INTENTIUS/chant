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
import { parseGcpCRD, type GcpParseResult } from "../spec/parse";
import { NamingStrategy, propertyTypeName } from "./naming";
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

/**
 * Extract the property-type suffix from a GCP `::` name and flatten to valid TS identifier.
 * "GCP::Alloydb::Backup::EncryptionConfig", "GCP::Alloydb::Backup" → "EncryptionConfig"
 * "GCP::Acm::AccessLevel::Custom::Expr", "GCP::Acm::AccessLevel" → "Custom_Expr"
 */
function gcpDefName(ptName: string, resourceType: string): string {
  const prefix = `${resourceType}::`;
  const raw = ptName.startsWith(prefix) ? ptName.slice(prefix.length) : ptName.split("::").pop()!;
  return raw.replace(/::/g, "_");
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
    for (const pt of r.propertyTypes) {
      const defName = gcpDefName(pt.name, cfnType);
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
  ];

  const emittedTypes = new Set<string>();

  for (const r of results) {
    const cfnType = r.resource.typeName;
    const tsName = naming.resolve(cfnType);
    if (!tsName) continue;

    // Resource class interface
    const desc = (r.resource.description ?? cfnType).replace(/\*\//g, "*\\/");
    lines.push(`/** ${desc} */`);
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
      const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop.name) ? prop.name : JSON.stringify(prop.name);
      const propDesc = prop.description ? `  /** ${prop.description.replace(/\*\//g, "*\\/")} */\n` : "";
      lines.push(`${propDesc}  ${safeName}${optional}: ${prop.tsType};`);
    }
    lines.push(`}`);
    lines.push("");

    // Aliases
    for (const alias of naming.aliases(cfnType)) {
      lines.push(`/** Alias for ${tsName} */`);
      lines.push(`export declare const ${alias}: typeof ${tsName};`);
      lines.push("");
    }

    // Property types (skip duplicates from singularization collisions)
    for (const pt of r.propertyTypes) {
      const defName = gcpDefName(pt.name, cfnType);
      const ptName = propertyTypeName(tsName, defName);
      if (emittedTypes.has(ptName)) continue;
      emittedTypes.add(ptName);

      lines.push(`export declare class ${ptName} {`);
      lines.push(`  constructor(props: ${ptName}Props);`);
      lines.push(`}`);
      lines.push("");

      lines.push(`export interface ${ptName}Props {`);
      for (const prop of pt.properties) {
        const optional = prop.required ? "" : "?";
        const safeName = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop.name) ? prop.name : JSON.stringify(prop.name);
        lines.push(`  ${safeName}${optional}: ${prop.tsType};`);
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
  const emittedProperties = new Set<string>();

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

    for (const pt of r.propertyTypes) {
      const defName = gcpDefName(pt.name, cfnType);
      const ptName = propertyTypeName(tsName, defName);
      if (emittedProperties.has(ptName)) continue;
      emittedProperties.add(ptName);
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
