/**
 * Lexicon JSON generator — produces lexicon-azure.json with metadata for all resources.
 *
 * Output is a Record<string, LexiconEntry> keyed by generated class name.
 */

import type { ArmSchemaParseResult } from "../spec/parse";
import { armShortName } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "azure";
  apiVersion?: string;
  attrs?: Record<string, string>;
  propertyConstraints?: Record<string, PropertyConstraints>;
  resourceLevelFields?: string[];
  tagging?: { taggable: boolean; tagOnCreate: boolean; tagUpdatable: boolean };
}

/**
 * Generate the lexicon-azure.json content.
 */
export function generateLexiconJSON(
  results: ArmSchemaParseResult[],
  naming: NamingStrategy,
): string {
  // Adapt ArmSchemaParseResult[] to RegistryResource[]
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes,
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: armShortName,
    buildEntry: (resource, _tsName, attrs, propConstraints) => {
      const armType = resource.typeName;
      const r = results.find((res) => res.resource.typeName === armType)!;

      return {
        resourceType: armType,
        kind: "resource" as const,
        lexicon: "azure" as const,
        apiVersion: r.resource.apiVersion,
        ...(attrs && { attrs }),
        ...(propConstraints && { propertyConstraints: propConstraints }),
        ...(r.resource.resourceLevelFields.length > 0 && {
          resourceLevelFields: r.resource.resourceLevelFields,
        }),
        ...(r.resource.tagging && { tagging: r.resource.tagging }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "azure" as const,
    }),
  });

  return serializeRegistry(entries);
}
