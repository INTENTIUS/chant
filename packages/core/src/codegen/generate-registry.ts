/**
 * Generic lexicon registry builder.
 *
 * Implements the shared loop: iterate parsed results, resolve naming,
 * build attrs/constraints maps, call format-specific entry builders,
 * handle aliases and property type sub-entries.
 */

import type { NamingStrategy } from "./naming";
import { propertyTypeName, extractDefName } from "./naming";
import { constraintsIsEmpty, type PropertyConstraints } from "./json-schema";

export interface RegistryResource {
  typeName: string;
  attributes: { name: string }[];
  properties: { name: string; constraints: PropertyConstraints }[];
  propertyTypes: { name: string; specType: string }[];
}

export interface RegistryConfig<E> {
  /** Short name extractor (e.g. shortName from the spec type). */
  shortName: (typeName: string) => string;
  /** Build a resource entry from parsed data. */
  buildEntry: (
    resource: RegistryResource,
    tsName: string,
    attrs: Record<string, string> | undefined,
    propConstraints: Record<string, PropertyConstraints> | undefined,
  ) => E;
  /** Build a property type entry. */
  buildPropertyEntry: (resourceType: string, propertyType: string) => E;
}

/**
 * Build a registry of entries from parsed results using the naming strategy.
 */
export function buildRegistry<E>(
  results: RegistryResource[],
  naming: NamingStrategy,
  config: RegistryConfig<E>,
): Record<string, E> {
  const entries: Record<string, E> = {};

  for (const r of results) {
    const typeName = r.typeName;
    const tsName = naming.resolve(typeName);
    if (!tsName) continue;

    // Build attrs map: name → raw name (identity mapping)
    let attrs: Record<string, string> | undefined;
    if (r.attributes.length > 0) {
      attrs = {};
      for (const a of r.attributes) {
        attrs[a.name] = a.name;
      }
    }

    // Build per-property constraints (skip empty)
    let propConstraints: Record<string, PropertyConstraints> | undefined;
    for (const p of r.properties) {
      if (!constraintsIsEmpty(p.constraints)) {
        if (!propConstraints) propConstraints = {};
        propConstraints[p.name] = p.constraints;
      }
    }

    const entry = config.buildEntry(r, tsName, attrs, propConstraints);
    entries[tsName] = entry;

    // Alias entries
    for (const alias of naming.aliases(typeName)) {
      entries[alias] = entry;
    }

    // Property type entries
    const shortName = config.shortName(typeName);
    const ptAliases = naming.propertyTypeAliases(typeName);

    for (const pt of r.propertyTypes) {
      const defName = extractDefName(pt.name, shortName);
      const ptName = propertyTypeName(tsName, defName);
      const ptEntry = config.buildPropertyEntry(typeName, pt.specType);
      entries[ptName] = ptEntry;

      if (ptAliases) {
        const aliasName = ptAliases.get(defName);
        if (aliasName) {
          entries[aliasName] = ptEntry;
        }
      }
    }
  }

  return entries;
}

/**
 * Sort registry keys and serialize to JSON.
 */
export function serializeRegistry(entries: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = entries[key];
  }
  return JSON.stringify(sorted, null, 2);
}
