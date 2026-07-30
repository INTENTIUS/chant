/**
 * Lexicon JSON generator — produces lexicon-fountain.json with metadata for the
 * fly resource and property types.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { FountainParseResult } from "../spec/parse";
import { fountainShortName } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import { buildRegistry, serializeRegistry, type RegistryResource } from "@intentius/chant/codegen/generate-registry";

export interface FountainLexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "fountain";
  /**
   * Per-property constraints. Named to match core's `LexiconEntry`
   * contract (and the aws/azure peers) — core reserves bare `constraints`
   * for the extension-constraint array, and the LSP providers read
   * property names off this key.
   */
  propertyConstraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-fountain.json content.
 */
export function generateLexiconJSON(results: FountainParseResult[], naming: NamingStrategy): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: [],
  }));

  const entries = buildRegistry<FountainLexiconEntry>(registryResources, naming, {
    shortName: fountainShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      const entry: FountainLexiconEntry = {
        resourceType: resource.typeName,
        kind: r?.isProperty ? "property" : "resource",
        lexicon: "fountain",
      };
      if (propConstraints && Object.keys(propConstraints).length > 0) {
        entry.propertyConstraints = propConstraints;
      }
      return entry;
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property",
      lexicon: "fountain",
    }),
  });

  return serializeRegistry(entries);
}
