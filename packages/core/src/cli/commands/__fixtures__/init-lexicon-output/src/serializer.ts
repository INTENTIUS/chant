import type { Serializer, Declarable } from "@intentius/chant";

/**
 * fixture serializer — produces minimal JSON output.
 *
 * TODO: Replace with your lexicon's output format.
 */
export const fixtureSerializer: Serializer = {
  name: "fixture",
  rulePrefix: "FIX",

  serialize(entities: Map<string, Declarable>): string {
    const resources: Record<string, unknown> = {};

    for (const [entityName, entity] of entities) {
      resources[entityName] = {
        type: entity.entityType,
        // TODO: Convert entity properties to your output format
      };
    }

    return JSON.stringify({ resources }, null, 2);
  },
};
