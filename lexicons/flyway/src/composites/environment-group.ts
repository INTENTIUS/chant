/**
 * environmentGroup composite — shared config with per-environment deep-merged overrides.
 *
 * Addresses the #1 Flyway feature request: per-environment custom
 * placeholders without repeating shared config. TypeScript + deep merge
 * gives a single source of truth with only diffs per environment.
 *
 * Deep merge semantics:
 * - Scalars: child wins (override)
 * - Objects (like placeholders): recursive merge — child keys override, parent keys preserved
 * - Arrays (like locations): replace, not concatenate
 */

/**
 * Deep-merge two plain objects. Arrays are replaced (not concatenated),
 * objects are recursively merged, scalars are overridden by child.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const [key, overrideVal] of Object.entries(override)) {
    const baseVal = result[key];

    if (
      overrideVal !== null &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }

  return result;
}

export interface EnvironmentOverride {
  /** JDBC URL for this environment. */
  url: string;
  /** Schemas (overrides shared schemas). */
  schemas?: string[];
  /** Per-environment flyway overrides — deep-merged with shared flyway config. */
  flyway?: Record<string, unknown>;
  /** Provisioner type. */
  provisioner?: string;
  /** User for this environment. */
  user?: string;
  /** Password for this environment. */
  password?: string;
  /** Additional environment properties. */
  [key: string]: unknown;
}

export interface EnvironmentGroupProps {
  /** Schemas shared across all environments (default: ["public"]). */
  schemas?: string[];
  /** Shared flyway config — deep-merged into each environment's flyway section. */
  flyway?: Record<string, unknown>;
  /** Per-environment overrides (deep-merged with shared config). */
  environments: Record<string, EnvironmentOverride>;
}

/**
 * Create an environment group — returns Environment props for each entry,
 * with shared config deep-merged into per-environment overrides.
 *
 * @example
 * ```ts
 * import { environmentGroup } from "@intentius/chant-lexicon-flyway";
 *
 * const envs = environmentGroup({
 *   schemas: ["public"],
 *   flyway: {
 *     locations: ["filesystem:migrations"],
 *     cleanDisabled: true,
 *     placeholders: { appName: "myapp", logLevel: "info" },
 *   },
 *   environments: {
 *     dev: {
 *       url: "jdbc:postgresql://localhost:5432/dev",
 *       flyway: { cleanDisabled: false, placeholders: { logLevel: "debug" } },
 *     },
 *     staging: {
 *       url: "jdbc:postgresql://staging:5432/app",
 *     },
 *     prod: {
 *       url: "jdbc:postgresql://prod:5432/app",
 *       flyway: { validateOnMigrate: true, placeholders: { logLevel: "warn" } },
 *     },
 *   },
 * });
 *
 * // envs.dev.flyway.placeholders = { appName: "myapp", logLevel: "debug" }
 * // envs.staging.flyway.placeholders = { appName: "myapp", logLevel: "info" }
 * // envs.prod.flyway.placeholders = { appName: "myapp", logLevel: "warn" }
 * ```
 */
export function environmentGroup(
  props: EnvironmentGroupProps,
): Record<string, Record<string, unknown>> {
  const { schemas = ["public"], flyway: sharedFlyway, environments } = props;

  const result: Record<string, Record<string, unknown>> = {};

  for (const [envName, envOverride] of Object.entries(environments)) {
    const { flyway: envFlyway, schemas: envSchemas, ...rest } = envOverride;

    const env: Record<string, unknown> = {
      ...rest,
      name: envName,
      schemas: envSchemas ?? schemas,
    };

    if (sharedFlyway || envFlyway) {
      env.flyway = sharedFlyway && envFlyway
        ? deepMerge(sharedFlyway, envFlyway)
        : (envFlyway ?? sharedFlyway);
    }

    result[envName] = env;
  }

  return result;
}
