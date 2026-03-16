/**
 * WFW101: Production Clean Enabled
 *
 * Detects production environments where cleanDisabled is false or missing.
 * Running `flyway clean` on a production database destroys all data.
 * cleanDisabled should always be true for production environments.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment, isProductionEnv } from "./flyway-helpers";

export const wfw101: PostSynthCheck = {
  id: "WFW101",
  description: "Production environment has cleanDisabled=false or missing — clean must be disabled in production",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      forEachEnvironment(config, (envName, env) => {
        if (!isProductionEnv(envName)) return;

        const envFlyway = env.flyway as Record<string, unknown> | undefined;
        const cleanDisabled = env.cleanDisabled ?? envFlyway?.cleanDisabled;

        if (cleanDisabled !== true) {
          diagnostics.push({
            checkId: "WFW101",
            severity: "error",
            message: `Production environment "${envName}" has cleanDisabled=${String(cleanDisabled ?? "missing")} — set cleanDisabled=true to prevent accidental data loss`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
