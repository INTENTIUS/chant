/**
 * Fountain naming strategy — maps Fountain::V1::{Kind} type names to
 * user-friendly TypeScript class names.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { fountainShortName, fountainServiceName, type FountainParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const flyNamingConfig: NamingConfig = {
  priorityNames: {
    "Fountain::V1::Environment": "Environment",
    "Fountain::V1::Agent": "Agent",
    "Fountain::V1::Vault": "Vault",
  },

  priorityAliases: {},

  priorityPropertyAliases: {},

  serviceAbbreviations: {
    V1: "V1",
  },

  shortName: fountainShortName,
  serviceName: fountainServiceName,
};

/**
 * Fountain-specific naming strategy. Extends the core strategy with the fountain config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: FountainParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, flyNamingConfig);
  }
}
