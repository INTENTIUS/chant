/**
 * WFW108: Missing Environment URL
 *
 * Detects environment sections that don't have a url property.
 * Every Flyway environment needs a JDBC URL to connect to the database.
 * A missing URL causes a runtime failure.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment } from "./flyway-helpers";

export const wfw108: PostSynthCheck = {
  id: "WFW108",
  description: "Environment section without url property — every environment needs a JDBC connection URL",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      forEachEnvironment(config, (envName, env) => {
        const url = env.url;

        if (url === undefined || url === null || (typeof url === "string" && url.trim() === "")) {
          diagnostics.push({
            checkId: "WFW108",
            severity: "error",
            message: `Environment "${envName}" is missing a url property — a JDBC connection URL is required`,
            entity: name,
            lexicon: "flyway",
          });
        }
      });
    }

    return diagnostics;
  },
};
