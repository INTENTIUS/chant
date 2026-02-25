/**
 * WFW103: Production Baseline On Migrate
 *
 * Detects production environments with baselineOnMigrate=true.
 * Baseline on migrate automatically creates a baseline in an existing
 * database, which can mask migration history issues in production.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment, isProductionEnv } from "./flyway-helpers";

export const wfw103: PostSynthCheck = {
  id: "WFW103",
  description: "Production environment has baselineOnMigrate=true — baseline on migrate is risky in production",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      forEachEnvironment(config, (envName, env) => {
        if (!isProductionEnv(envName)) return;

        const envFlyway = env.flyway as Record<string, unknown> | undefined;
        const baselineOnMigrate = env.baselineOnMigrate ?? envFlyway?.baselineOnMigrate;

        if (baselineOnMigrate === true) {
          diagnostics.push({
            checkId: "WFW103",
            severity: "warning",
            message: `Production environment "${envName}" has baselineOnMigrate=true — this can mask migration history issues in production`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
