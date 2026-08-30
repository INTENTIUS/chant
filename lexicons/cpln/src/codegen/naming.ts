/**
 * cpln naming strategy.
 *
 * Every generated type is `Cpln::Core::{Name}` with a `{Name}` the parser has
 * already made unique — `$ref`'d schemas take their upstream name and inline
 * shapes take their path — so the core strategy's collision phases never fire
 * and `resolve` returns the last segment unchanged. The value of going through
 * the core strategy anyway is phase 1a: once this lexicon publishes a surface
 * snapshot, a name that has shipped stays attached to the type that shipped it
 * even if an upstream reshuffle would otherwise hand it to a newcomer.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  reservedNamesFromSnapshot,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { cplnShortName, cplnServiceName, KINDS, SERVICE } from "../kinds";
import type { CplnParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

/**
 * The eight kinds are pinned by hand. They are the names users type, and they
 * should not move because a property type elsewhere in the spec started or
 * stopped existing.
 */
const priorityNames: Record<string, string> = Object.fromEntries(
  KINDS.map((k) => [k.typeName, k.className]),
);

const cplnNamingConfig: NamingConfig = {
  priorityNames,
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: { [SERVICE]: SERVICE },
  shortName: cplnShortName,
  serviceName: cplnServiceName,
};

export interface CplnNamingOptions {
  /** A committed `surface.snapshot.json`, when one exists. */
  snapshot?: { entries?: Record<string, { kind?: string; resourceType?: string }> };
}

/**
 * cpln-specific naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: CplnParseResult[], options: CplnNamingOptions = {}) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, {
      ...cplnNamingConfig,
      reservedNames: reservedNamesFromSnapshot(options.snapshot),
    });
  }
}
