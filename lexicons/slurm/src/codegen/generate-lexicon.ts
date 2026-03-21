/**
 * Lexicon JSON generator — produces lexicon-slurm.json.
 *
 * Each entry provides the resource type, lexicon name, and any attribute
 * mappings needed by the runtime.
 */

import type { SlurmParseResult } from "../spec/parse";
import { slurmShortName } from "../spec/parse";
import type { NamingStrategy } from "./naming";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";

export interface SlurmLexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "slurm";
  description?: string;
}

/**
 * Generate the lexicon-slurm.json content.
 */
export function generateLexiconJSON(
  results: SlurmParseResult[],
  naming: NamingStrategy,
): string {
  // Adapt SlurmParseResult[] → RegistryResource[]
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attrDefs,
    properties: r.resource.propDefs,
    propertyTypes: r.resource.propertyTypesList,
  }));

  const entries = buildRegistry<SlurmLexiconEntry>(registryResources, naming, {
    shortName: slurmShortName,
    buildEntry: (resource, _tsName, _attrs, _propConstraints) => {
      const r = results.find((res) => res.resource.typeName === resource.typeName)!;
      return {
        resourceType: resource.typeName,
        kind: "resource" as const,
        lexicon: "slurm" as const,
        ...(r.resource.description && { description: r.resource.description }),
      };
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property" as const,
      lexicon: "slurm" as const,
    }),
  });

  return serializeRegistry(entries);
}
