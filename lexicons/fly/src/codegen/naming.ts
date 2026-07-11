/**
 * Fly naming strategy — maps Fly::Machines::{Kind} type names to
 * user-friendly TypeScript class names.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { flyShortName, flyServiceName, type FlyParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const flyNamingConfig: NamingConfig = {
  priorityNames: {
    "Fly::Machines::App": "App",
    "Fly::Machines::Machine": "Machine",
    "Fly::Machines::Volume": "Volume",
  },

  priorityAliases: {},

  priorityPropertyAliases: {},

  serviceAbbreviations: {
    Machines: "Machines",
  },

  shortName: flyShortName,
  serviceName: flyServiceName,
};

/**
 * Fly-specific naming strategy. Extends the core strategy with the fly config.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: FlyParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, flyNamingConfig);
  }
}
