/**
 * Slurm REST API schema parser.
 *
 * Converts a SlurmResourceDef (serialized as JSON) into a SlurmParseResult
 * that the generatePipeline can consume for naming, registry, and TypeScript
 * declaration generation.
 */

import type { ParsedResult } from "@intentius/chant/codegen/generate";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { SlurmResourceDef, SlurmPropDef } from "./slurm-rest-spec";

// ── Parsed types ────────────────────────────────────────────────────

export interface SlurmParsedProperty {
  name: string;
  tsType: string;
  required: boolean;
  description?: string;
  constraints: PropertyConstraints;
}

export interface SlurmParseResult extends ParsedResult {
  resource: {
    typeName: string;
    description?: string;
    properties: SlurmParsedProperty[];
    attributes: Array<{ name: string }>;
    // RegistryResource compat
    attrDefs: Array<{ name: string }>;
    propDefs: Array<{ name: string; constraints: PropertyConstraints }>;
    propertyTypesList: Array<{ name: string; specType: string }>;
  };
  propertyTypes: Array<{ name: string; specType: string; properties: SlurmParsedProperty[] }>;
  enums: Array<{ name: string; values: string[] }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function toTsType(prop: SlurmPropDef): string {
  switch (prop.type) {
    case "string":
      return "string";
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "Record<string, string>";
    case "array":
      return `Array<${prop.items ? toTsType(prop.items as SlurmPropDef) : "unknown"}>`;
    default:
      return "unknown";
  }
}

/**
 * Short name extractor for Slurm type names.
 * "Slurm::Rest::Job" → "Job"
 */
export function slurmShortName(typeName: string): string {
  return typeName.split("::").pop() ?? typeName;
}

/**
 * Service name extractor for Slurm type names.
 * "Slurm::Rest::Job" → "Rest"
 */
export function slurmServiceName(typeName: string): string {
  return typeName.split("::")[1] ?? typeName;
}

// ── Main parser ──────────────────────────────────────────────────────

/**
 * Parse a serialized SlurmResourceDef buffer into a SlurmParseResult.
 */
export function parseSlurmSchema(typeName: string, data: Buffer): SlurmParseResult {
  const def = JSON.parse(data.toString()) as SlurmResourceDef;

  const properties: SlurmParsedProperty[] = Object.entries(def.properties).map(
    ([name, prop]) => ({
      name,
      tsType: toTsType(prop),
      required: prop.required ?? false,
      description: prop.description,
      constraints: {},
    }),
  );

  return {
    resource: {
      typeName: def.typeName,
      description: def.description,
      properties,
      attributes: [],
      // RegistryResource-compatible aliases
      attrDefs: [],
      propDefs: properties.map((p) => ({ name: p.name, constraints: p.constraints })),
      propertyTypesList: [],
    },
    propertyTypes: [],
    enums: [],
  };
}
