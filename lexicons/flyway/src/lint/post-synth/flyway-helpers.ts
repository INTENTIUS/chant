/**
 * Shared helpers for Flyway post-synthesis lint rules.
 *
 * Provides TOML parsing and environment iteration logic that is common
 * across all WFW post-synth checks.
 */

import { parseTOML } from "@intentius/chant/toml";
export { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

/**
 * A parsed Flyway TOML config (loosely typed).
 */
export interface FlywayTOMLConfig {
  flyway?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
  flywayDesktop?: Record<string, unknown>;
  redgateCompare?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parse the primary Flyway TOML output from a build output string.
 */
export function parseFlywayTOML(output: string): FlywayTOMLConfig {
  const toml = getPrimaryOutput(output);
  return parseTOML(toml) as FlywayTOMLConfig;
}

/**
 * Iterate over all environments in a Flyway config, calling the callback
 * for each one. Skips non-object entries gracefully.
 */
export function forEachEnvironment(
  config: FlywayTOMLConfig,
  cb: (envName: string, envConfig: Record<string, unknown>) => void,
): void {
  const environments = config.environments;
  if (!environments || typeof environments !== "object") return;

  for (const [envName, envConfig] of Object.entries(environments)) {
    if (typeof envConfig !== "object" || envConfig === null) continue;
    cb(envName, envConfig as Record<string, unknown>);
  }
}

/**
 * Check if an environment name suggests it is a production environment.
 */
export function isProductionEnv(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("prod");
}

/**
 * Extract the `[flyway]` section from a parsed config.
 */
export function getFlywaySection(
  config: FlywayTOMLConfig,
): Record<string, unknown> | undefined {
  const flyway = config.flyway;
  if (!flyway || typeof flyway !== "object") return undefined;
  return flyway as Record<string, unknown>;
}
