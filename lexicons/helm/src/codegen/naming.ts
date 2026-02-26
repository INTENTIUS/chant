/**
 * Helm naming strategy — trivial mapping since Helm types are few and static.
 *
 * Maps Helm::{TypeName} → TypeName (e.g. Helm::Chart → Chart).
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";

const helmNamingConfig: NamingConfig = {
  priorityNames: {
    "Helm::Chart": "Chart",
    "Helm::Values": "Values",
    "Helm::Test": "HelmTest",
    "Helm::Notes": "HelmNotes",
    "Helm::Hook": "HelmHook",
    "Helm::Dependency": "HelmDependency",
  },

  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},

  shortName: (typeName: string) => typeName.split("::").pop() ?? typeName,
  serviceName: (_typeName: string) => "Helm",
};

/**
 * Helm naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(inputs: NamingInput[]) {
    super(inputs, helmNamingConfig);
  }
}
