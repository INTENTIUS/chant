import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN014: a Vault key that collides with a declared Environment key.
 *
 * Vault values win on key collision at spawn — silently. Shadowing a
 * reviewed environment value is sometimes exactly the point (staging
 * overrides) and sometimes an accident; either way it should be visible
 * in review, so collisions warn.
 */

function keysOf(spec: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const envVars = spec.env_vars;
  if (envVars && typeof envVars === "object") for (const k of Object.keys(envVars)) keys.add(k);
  const secrets = spec.secrets;
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      const key = (s as { key?: unknown })?.key;
      if (typeof key === "string") keys.add(key);
    }
  }
  return keys;
}

export const vaultShadowingCheck: PostSynthCheck = {
  id: "FTN014",
  description: "Vault keys shadowing a declared Environment key should be visible in review",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const environments: Array<[string, Set<string>]> = [];
    const vaults: Array<[string, Set<string>]> = [];

    for (const [name, entity] of ctx.entities) {
      const spec = entity as unknown as Record<string, unknown>;
      if (entity.entityType === "Fountain::V1::Environment") environments.push([name, keysOf(spec)]);
      if (entity.entityType === "Fountain::V1::Vault") vaults.push([name, keysOf(spec)]);
    }

    for (const [vaultName, vaultKeys] of vaults) {
      for (const [envName, envKeys] of environments) {
        const shadowed = [...vaultKeys].filter((k) => envKeys.has(k));
        if (shadowed.length > 0) {
          diagnostics.push({
            checkId: "FTN014",
            severity: "warning",
            message:
              `Vault "${vaultName}" shadows ${shadowed.map((k) => `"${k}"`).join(", ")} from ` +
              `environment "${envName}" — vault values win silently on collision at spawn`,
            entity: vaultName,
            lexicon: "fountain",
          });
        }
      }
    }

    return diagnostics;
  },
};
