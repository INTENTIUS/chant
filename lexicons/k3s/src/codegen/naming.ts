/**
 * k3s naming strategy — flat namespace, one short name per entity.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { k3sShortName, k3sServiceName, type K3sParseResult } from "./parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const k3sNamingConfig: NamingConfig = {
  priorityNames: {
    "K3s::Server": "Server",
    "K3s::Agent": "Agent",
    "K3s::Registries": "Registries",
    "K3s::Mirror": "Mirror",
    "K3s::RegistryConfig": "RegistryConfig",
    "K3s::RegistryAuth": "RegistryAuth",
    "K3s::RegistryTLS": "RegistryTLS",
  },
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: k3sShortName,
  serviceName: k3sServiceName,
};

/**
 * k3s naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: K3sParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, k3sNamingConfig);
  }
}
