import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN012: no cloud-credential-shaped values in Environment env_vars.
 *
 * Everything materialized into a sandbox must be presumed exfiltrated the
 * moment untrusted agent code starts. `env_vars` is plaintext config —
 * anything credential-shaped belongs in secrets at minimum, and long-lived
 * cloud credentials should not enter the sandbox at all (see
 * BinaryBourbon/fountain#148 for the token-only model).
 */

const CREDENTIAL_KEYS = /^(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET)$/i;
const CREDENTIAL_VALUES = /^(AKIA[0-9A-Z]{16}|(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})$/;

export const noCloudCredentialEnvCheck: PostSynthCheck = {
  id: "FTN012",
  description: "Environment env_vars must not carry cloud-credential-shaped keys or values",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Environment") continue;
      const envVars = (entity as unknown as { env_vars?: Record<string, unknown> }).env_vars;
      if (!envVars || typeof envVars !== "object") continue;

      for (const [key, value] of Object.entries(envVars)) {
        if (CREDENTIAL_KEYS.test(key)) {
          diagnostics.push({
            checkId: "FTN012",
            severity: "error",
            message:
              `Environment "${name}" env_vars carries cloud-credential key "${key}" — ` +
              `credentials must not be materialized into the sandbox`,
            entity: name,
            lexicon: "fountain",
          });
          continue;
        }
        if (typeof value === "string" && CREDENTIAL_VALUES.test(value)) {
          diagnostics.push({
            checkId: "FTN012",
            severity: "error",
            message:
              `Environment "${name}" env_vars["${key}"] looks like a literal credential — ` +
              `use secrets or a \${VAR} reference, never a plaintext value`,
            entity: name,
            lexicon: "fountain",
          });
        }
      }
    }

    return diagnostics;
  },
};
