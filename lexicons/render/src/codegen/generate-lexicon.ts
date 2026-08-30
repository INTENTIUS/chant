/**
 * Lexicon JSON generator — produces lexicon-render.json with metadata for the
 * render resource and property types.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import type { RenderParseResult } from "../spec/parse";
import { renderShortName } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import { buildRegistry, serializeRegistry, type RegistryResource } from "@intentius/chant/codegen/generate-registry";

export interface RenderLexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "render";
  constraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the lexicon-render.json content.
 */
export function generateLexiconJSON(results: RenderParseResult[], naming: NamingStrategy): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: [],
  }));

  const entries = buildRegistry<RenderLexiconEntry>(registryResources, naming, {
    shortName: renderShortName,
    buildEntry: (resource, _tsName, _attrs, propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName);
      const entry: RenderLexiconEntry = {
        resourceType: resource.typeName,
        kind: r?.isProperty ? "property" : "resource",
        lexicon: "render",
      };
      if (propConstraints && Object.keys(propConstraints).length > 0) {
        entry.constraints = propConstraints;
      }
      return entry;
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property",
      lexicon: "render",
    }),
  });

  return serializeRegistry(entries);
}
