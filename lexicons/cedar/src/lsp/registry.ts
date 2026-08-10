/**
 * The generated registry, adapted to what core's `LexiconIndex` reads.
 *
 * `lexicon-cedar.json` describes every declaration the project's schema
 * produced (#1650): the `Policy` authoring class, one entry per entity type,
 * one per action, and the attribute/context record types beside them. Its
 * property table is keyed `properties`, while `LexiconIndex.getPropertyNames`
 * looks at `propertyConstraints` — the CloudFormation-shaped name the class was
 * written against. Renaming the generated key to match would put a
 * CloudFormation word in a Cedar artifact; translating here does not, and it is
 * the only reason this module exists.
 *
 * The require is lazy and cached. `generate()` writes the registry, so a
 * checkout that has not run it yet must still be able to import this file —
 * the LSP tests skip on exactly that condition.
 */

import { createRequire } from "module";
import { LexiconIndex, type LexiconEntry } from "@intentius/chant/lsp/lexicon-providers";
import { LEXICON_JSON_FILENAME } from "../codegen/generate";

const require = createRequire(import.meta.url);

/** One `lexicon-cedar.json` entry, as {@link generateRegistry} writes it. */
export interface CedarRegistryEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: string;
  description?: string;
  /** Cedar namespace the declaration came from, e.g. `App`. */
  namespace?: string;
  /** Entity types this one is `in`, for an entity declaration. */
  memberOfTypes?: string[];
  /** `appliesTo.principal`, for an action declaration. */
  principalTypes?: string[];
  /** `appliesTo.resource`, for an action declaration. */
  resourceTypes?: string[];
  enumValues?: string[];
  properties?: Record<string, { type: string; required: boolean }>;
}

export type CedarRegistry = Record<string, CedarRegistryEntry>;

let cachedRegistry: CedarRegistry | null = null;
let cachedIndex: LexiconIndex | null = null;

/** The raw registry, for the hover formatter's Cedar-specific fields. */
export function cedarRegistry(): CedarRegistry {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = require(`../generated/${LEXICON_JSON_FILENAME}`) as CedarRegistry;
  return cachedRegistry;
}

/** The same registry as a `LexiconIndex`, with the property table translated. */
export function cedarIndex(): LexiconIndex {
  if (cachedIndex) return cachedIndex;
  const entries: Record<string, LexiconEntry> = {};
  for (const [className, entry] of Object.entries(cedarRegistry())) {
    entries[className] = {
      resourceType: entry.resourceType,
      kind: entry.kind,
      lexicon: entry.lexicon,
      propertyConstraints: entry.properties ?? {},
    };
  }
  cachedIndex = new LexiconIndex(entries);
  return cachedIndex;
}

/** Reset the caches. Tests that swap the registry on disk need this; nothing else does. */
export function resetCedarIndexCache(): void {
  cachedRegistry = null;
  cachedIndex = null;
}
