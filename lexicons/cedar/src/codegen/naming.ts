import { NamingStrategy, type NamingConfig, type NamingInput } from "@intentius/chant/codegen/naming";

/**
 * Naming configuration for this lexicon.
 *
 * TODO: Populate these tables with your provider's naming conventions.
 */
export const namingConfig: NamingConfig = {
  // High-priority short names for common resource types
  priorityNames: {},

  // Aliases for resource types that need alternate names
  priorityAliases: {},

  // Aliases for property types
  priorityPropertyAliases: {},

  // Abbreviations for service names (used in collision resolution)
  serviceAbbreviations: {},

  // Extract the short name from a fully-qualified type string
  shortName: (typeName: string) => typeName.split("::").pop()!,

  // Extract the service name from a fully-qualified type string
  serviceName: (typeName: string) => typeName.split("::")[1] ?? typeName,
};

/**
 * Create a NamingStrategy instance from parsed results.
 */
export function createNaming(inputs: NamingInput[]): NamingStrategy {
  return new NamingStrategy(inputs, namingConfig);
}
