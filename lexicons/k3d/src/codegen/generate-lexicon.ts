/**
 * Lexicon JSON generator — produces lexicon-k3d.json with metadata
 * for all k3d entities.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { K3dParseResult } from "./parse";
import { k3dShortName } from "./parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "k3d";
  deprecatedProperties?: string[];
  constraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-k3d.json content.
 */
export function generateLexiconJSON(
  results: K3dParseResult[],
  naming: NamingStrategy,
): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes.map((pt) => ({ name: pt.name, specType: pt.defType })),
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: k3dShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      return {
        resourceType: resource.typeName,
        kind: (r?.isProperty ? "property" : "resource") as "resource" | "property",
        lexicon: "k3d" as const,
        ...(r?.resource.deprecatedProperties?.length && { deprecatedProperties: r.resource.deprecatedProperties }),
        ...(propConstraints && Object.keys(propConstraints).length > 0 && { constraints: propConstraints }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "k3d" as const,
    }),
  });

  return serializeRegistry(entries);
}
