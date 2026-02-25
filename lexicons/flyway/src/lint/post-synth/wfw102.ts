/**
 * WFW102: Production Validate On Migrate Missing
 *
 * Detects production environments missing validateOnMigrate=true.
 * Validation ensures that applied migrations haven't been tampered with,
 * which is critical for production database integrity.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment, isProductionEnv } from "./flyway-helpers";

export const wfw102: PostSynthCheck = {
  id: "WFW102",
  description: "Production environment missing validateOnMigrate=true — validation should be enabled in production",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      forEachEnvironment(config, (envName, env) => {
        if (!isProductionEnv(envName)) return;

        const envFlyway = env.flyway as Record<string, unknown> | undefined;
        const validateOnMigrate = env.validateOnMigrate ?? envFlyway?.validateOnMigrate;

        if (validateOnMigrate !== true) {
          diagnostics.push({
            checkId: "WFW102",
            severity: "warning",
            message: `Production environment "${envName}" is missing validateOnMigrate=true — enable validation to detect tampered migrations`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
