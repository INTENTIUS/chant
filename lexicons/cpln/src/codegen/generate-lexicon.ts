/**
 * Lexicon registry generator — produces `lexicon-cpln.json`, the metadata the
 * evaluator and lint engine read for each cpln resource and property type.
 */

import type { PropertyConstraints } from "@intentius/chant/codegen/json-schema";
import {
  buildRegistry,
  serializeRegistry,
  type RegistryResource,
} from "@intentius/chant/codegen/generate-registry";
import { cplnShortName, kindByTypeName } from "../kinds";
import type { CplnParseResult } from "../spec/parse";
import type { NamingStrategy } from "./naming";

export interface CplnLexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: "cpln";
  /** The `kind` discriminator a manifest carries. Resources only. */
  cplnKind?: string;
  /** Whether the resource is addressed under a GVC. Resources only. */
  gvcScoped?: boolean;
  /**
   * Per-property constraints.
   *
   * Named to match core's `LexiconEntry` contract rather than the bare
   * `constraints` it would be natural to call it. The name is load-bearing
   * twice over: `LexiconIndex.getPropertyNames` derives the LSP's property
   * completions from *the keys of this object*, and hover reads the enums out
   * of its values. Under any other key both features return nothing, with no
   * error — the index simply finds no properties.
   *
   * Every writable property gets an entry for the same reason, even when it
   * carries no constraints at all. A property omitted here is a property that
   * does not complete.
   */
  propertyConstraints?: Record<string, PropertyConstraints>;
}

/**
 * Generate the `lexicon-cpln.json` content.
 */
export function generateLexiconJSON(results: CplnParseResult[], naming: NamingStrategy): string {
  const registryResources: RegistryResource[] = results.map((r) => ({
    typeName: r.resource.typeName,
    attributes: r.resource.attributes,
    properties: r.resource.properties,
    propertyTypes: [],
  }));

  // Every writable property, with its constraints — see `propertyConstraints`.
  const byTypeName = new Map(results.map((r) => [r.resource.typeName, r] as const));

  const entries = buildRegistry<CplnLexiconEntry>(registryResources, naming, {
    shortName: cplnShortName,
    buildEntry: (resource) => {
      const kind = kindByTypeName(resource.typeName);
      const entry: CplnLexiconEntry = {
        resourceType: resource.typeName,
        kind: kind ? "resource" : "property",
        lexicon: "cpln",
      };
      if (kind) {
        // Carried on the entry so the serializer and observation can route a
        // resource without re-deriving the mapping from its class name.
        entry.cplnKind = kind.kind;
        entry.gvcScoped = kind.gvcScoped;
      }

      const parsed = byTypeName.get(resource.typeName);
      const constraints: Record<string, PropertyConstraints> = {};
      for (const property of parsed?.resource.properties ?? []) {
        constraints[property.name] = property.constraints ?? {};
      }
      if (Object.keys(constraints).length > 0) entry.propertyConstraints = constraints;

      return entry;
    },
    buildPropertyEntry: (resourceType, propertyType) => ({
      resourceType: `${resourceType}.${propertyType}`,
      kind: "property",
      lexicon: "cpln",
    }),
  });

  return serializeRegistry(entries);
}
