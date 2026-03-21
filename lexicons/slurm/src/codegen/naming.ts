/**
 * Slurm naming strategy.
 *
 * Wraps the core NamingStrategy with Slurm-specific configuration.
 * Slurm::Rest::Job → "Job", Slurm::Rest::QoS → "QoS", etc.
 */

import { NamingStrategy as CoreNamingStrategy, type NamingConfig, type NamingInput } from "@intentius/chant/codegen/naming";
import { slurmShortName, slurmServiceName, type SlurmParseResult } from "../spec/parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const priorityNames: Record<string, string> = {
  "Slurm::Rest::Job": "Job",
  "Slurm::Rest::Reservation": "Reservation",
  "Slurm::Rest::QoS": "QoS",
};

const slurmNamingConfig: NamingConfig = {
  priorityNames,
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: slurmShortName,
  serviceName: slurmServiceName,
};

/**
 * Slurm-specific NamingStrategy — wraps the core algorithm with Slurm tables.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: SlurmParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, slurmNamingConfig);
  }
}
