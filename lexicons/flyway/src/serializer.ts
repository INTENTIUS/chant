/**
 * Flyway TOML serializer.
 *
 * Converts Chant declarables to flyway.toml output with proper
 * TOML namespaces: [flyway], [environments.<name>], [flywayDesktop],
 * [redgateCompare].
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { emitTOML } from "@intentius/chant/toml";

/**
 * Flyway visitor for the generic serializer walker.
 */
function flywayVisitor(_entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    resourceRef: (name) => name,
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          result[key] = walk(value);
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

/**
 * Convert a value to TOML-compatible form using the walker.
 */
function toTOMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, flywayVisitor(entityNames));
}

/** Entity type prefix constants. */
const FLYWAY_PROJECT = "Flyway::Project";
const FLYWAY_CONFIG = "Flyway::Config";
const FLYWAY_ENV = "Flyway::Environment";
const FLYWAY_DESKTOP = "Flyway::FlywayDesktop";
const FLYWAY_REDGATE = "Flyway::RedgateCompare";

/**
 * Key ordering for the [flyway] namespace — most important keys first.
 */
const FLYWAY_KEY_ORDER = [
  "locations",
  "defaultSchema",
  "schemas",
  "encoding",
  "validateMigrationNaming",
  "validateOnMigrate",
  "outOfOrder",
  "cleanDisabled",
  "baselineOnMigrate",
  "baselineVersion",
  "baselineDescription",
  "sqlMigrationPrefix",
  "sqlMigrationSeparator",
  "sqlMigrationSuffixes",
  "repeatableMigrationPrefix",
  "table",
  "tablespace",
  "group",
  "mixed",
  "cherryPick",
  "callbackLocations",
  "skipExecutingMigrations",
  "placeholders",
];

/**
 * Key ordering for environment sections.
 */
const ENV_KEY_ORDER = [
  "url",
  "user",
  "password",
  "displayName",
  "schemas",
  "provisioner",
  "resolvers",
  "flyway",
];

/**
 * Flyway TOML serializer implementation.
 */
export const flywaySerializer: Serializer = {
  name: "flyway",
  rulePrefix: "WFW",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string | SerializerResult {
    // Build reverse map: entity → name
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    // Collect entities by type
    const projects: Array<[string, Declarable]> = [];
    const configs: Array<[string, Declarable]> = [];
    const environments: Array<[string, Declarable]> = [];
    const desktopConfigs: Array<[string, Declarable]> = [];
    const redgateConfigs: Array<[string, Declarable]> = [];

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue;

      const entityType = (entity as unknown as Record<string, unknown>).entityType as string;
      if (entityType === FLYWAY_PROJECT) {
        projects.push([name, entity]);
      } else if (entityType === FLYWAY_CONFIG) {
        configs.push([name, entity]);
      } else if (entityType === FLYWAY_ENV) {
        environments.push([name, entity]);
      } else if (entityType === FLYWAY_DESKTOP) {
        desktopConfigs.push([name, entity]);
      } else if (entityType === FLYWAY_REDGATE) {
        redgateConfigs.push([name, entity]);
      }
    }

    // Build the top-level TOML object
    const doc: Record<string, unknown> = {};

    // Emit project-level properties at root
    for (const [, entity] of projects) {
      const props = toTOMLValue(
        (entity as unknown as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (props) {
        // Project props go at the root level
        for (const [key, val] of Object.entries(props)) {
          if (val !== undefined) doc[key] = val;
        }
      }
    }

    // Emit [flyway] namespace
    for (const [, entity] of configs) {
      const props = toTOMLValue(
        (entity as unknown as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (props && Object.keys(props).length > 0) {
        doc.flyway = { ...(doc.flyway as Record<string, unknown> ?? {}), ...props };
      }
    }

    // Emit [environments.<name>] sections
    if (environments.length > 0) {
      const envs: Record<string, unknown> = {};
      for (const [name, entity] of environments) {
        const props = toTOMLValue(
          (entity as unknown as Record<string, unknown>).props,
          entityNames,
        ) as Record<string, unknown> | undefined;
        if (props) {
          // Use the logical name as the environment name
          const envName = (props.displayName as string) || name;
          const envObj: Record<string, unknown> = {};

          for (const [key, val] of Object.entries(props)) {
            if (key === "displayName") continue; // displayName is used as the section key
            if (val !== undefined) envObj[key] = val;
          }

          envs[envName] = envObj;
        }
      }
      if (Object.keys(envs).length > 0) {
        doc.environments = envs;
      }
    }

    // Emit [flywayDesktop] namespace
    for (const [, entity] of desktopConfigs) {
      const props = toTOMLValue(
        (entity as unknown as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (props && Object.keys(props).length > 0) {
        doc.flywayDesktop = props;
      }
    }

    // Emit [redgateCompare] namespace
    for (const [, entity] of redgateConfigs) {
      const props = toTOMLValue(
        (entity as unknown as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (props && Object.keys(props).length > 0) {
        doc.redgateCompare = props;
      }
    }

    return emitTOML(doc, {
      header: "Generated by Chant — do not edit manually",
      keyOrder: ["id", "name", "databaseType", "flyway", "environments", "flywayDesktop", "redgateCompare"],
    });
  },
};
