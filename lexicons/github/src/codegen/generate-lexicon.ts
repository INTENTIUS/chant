/**
 * Lexicon JSON generator — produces lexicon-github.json with metadata
 * for all GitHub Actions entities.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { GitHubParseResult } from "./parse";
import { githubShortName } from "./parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "github";
  deprecatedProperties?: string[];
  constraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-github.json content.
 */
export function generateLexiconJSON(
  results: GitHubParseResult[],
  naming: NamingStrategy,
): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes.map((pt) => ({ name: pt.name, specType: pt.defType })),
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: githubShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      return {
        resourceType: resource.typeName,
        kind: (r?.isProperty ? "property" : "resource") as "resource" | "property",
        lexicon: "github" as const,
        ...(r?.resource.deprecatedProperties?.length && { deprecatedProperties: r.resource.deprecatedProperties }),
        ...(propConstraints && Object.keys(propConstraints).length > 0 && { constraints: propConstraints }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "github" as const,
    }),
  });

  return serializeRegistry(entries);
}
