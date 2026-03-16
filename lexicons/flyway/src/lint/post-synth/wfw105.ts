/**
 * WFW105: Empty Locations
 *
 * Detects configurations where flyway.locations is empty or missing.
 * Without locations, Flyway has no migration files to apply, which is
 * almost certainly a configuration error.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, getFlywaySection } from "./flyway-helpers";

export const wfw105: PostSynthCheck = {
  id: "WFW105",
  description: "flyway.locations is empty or missing — Flyway needs at least one migration location",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);
      const flyway = getFlywaySection(config);

      if (!flyway) {
        diagnostics.push({
          checkId: "WFW105",
          severity: "error",
          message: `Missing flyway.locations — Flyway needs at least one migration location`,
          entity: name,
          lexicon: "flyway",
        });
        continue;
      }

      const locations = flyway.locations;
      if (
        locations === undefined ||
        locations === null ||
        (Array.isArray(locations) && locations.length === 0) ||
        (typeof locations === "string" && locations.trim() === "")
      ) {
        diagnostics.push({
          checkId: "WFW105",
          severity: "error",
          message: `flyway.locations is empty or missing — Flyway needs at least one migration location`,
          entity: name,
          lexicon: "flyway",
        });
      }
    }

    return diagnostics;
  },
};
