/**
 * Lexicon JSON generator: writes lexicon-prow.json with metadata
 * for all prow entities.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { ProwParseResult } from "./parse";
import { prowShortName } from "./parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "prow";
  deprecatedProperties?: string[];
  constraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-prow.json content.
 */
export function generateLexiconJSON(
  results: ProwParseResult[],
  naming: NamingStrategy,
): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes.map((pt) => ({ name: pt.name, specType: pt.defType })),
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: prowShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      return {
        resourceType: resource.typeName,
        kind: (r?.isProperty ? "property" : "resource") as "resource" | "property",
        lexicon: "prow" as const,
        ...(r?.resource.deprecatedProperties?.length && { deprecatedProperties: r.resource.deprecatedProperties }),
        ...(propConstraints && Object.keys(propConstraints).length > 0 && { constraints: propConstraints }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "prow" as const,
    }),
  });

  return serializeRegistry(entries);
}
