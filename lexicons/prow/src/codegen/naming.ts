/**
 * prow naming strategy: one flat namespace, each entity named by its short
 * name (Prow::PodSpec is PodSpec).
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { prowShortName, prowServiceName, type ProwParseResult } from "./parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

/**
 * prow naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: ProwParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    const config: NamingConfig = {
      priorityNames: Object.fromEntries(results.map((r) => [r.resource.typeName, prowShortName(r.resource.typeName)])),
      priorityAliases: {},
      priorityPropertyAliases: {},
      serviceAbbreviations: {},
      shortName: prowShortName,
      serviceName: prowServiceName,
    };
    super(inputs, config);
  }
}
