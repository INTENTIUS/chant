/**
 * Lexicon JSON generator — produces lexicon-gitlab.json with metadata
 * for all GitLab CI entities.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { GitLabParseResult } from "./parse";
import { gitlabShortName } from "./parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "gitlab";
  deprecatedProperties?: string[];
  constraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-gitlab.json content.
 */
export function generateLexiconJSON(
  results: GitLabParseResult[],
  naming: NamingStrategy,
): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: r.propertyTypes.map((pt) => ({ name: pt.name, specType: pt.defType })),
  }));

  const entries = buildRegistry<LexiconEntry>(registryResources, naming, {
    shortName: gitlabShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      return {
        resourceType: resource.typeName,
        kind: (r?.isProperty ? "property" : "resource") as "resource" | "property",
        lexicon: "gitlab" as const,
        ...(r?.resource.deprecatedProperties?.length && { deprecatedProperties: r.resource.deprecatedProperties }),
        ...(propConstraints && Object.keys(propConstraints).length > 0 && { constraints: propConstraints }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "gitlab" as const,
    }),
  });

  return serializeRegistry(entries);
}
