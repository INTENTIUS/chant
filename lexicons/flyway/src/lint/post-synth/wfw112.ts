/**
 * WFW112: Mixed Versioned and Repeatable Migrations in Same Locations
 *
 * Warns when the [flyway] section has `locations` configured and also has
 * `repeatableSqlMigrationPrefix` explicitly set. This suggests both versioned
 * and repeatable migrations will run from the same locations, which can make
 * migration ordering harder to reason about. Consider using separate locations.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, getFlywaySection } from "./flyway-helpers";

export const wfw112: PostSynthCheck = {
  id: "WFW112",
  description: "Mixed versioned and repeatable migrations configured for the same locations",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);
      const flyway = getFlywaySection(config);
      if (!flyway) continue;

      const hasLocations = Array.isArray(flyway.locations) && flyway.locations.length > 0;
      const hasRepeatablePrefix = "repeatableSqlMigrationPrefix" in flyway;

      if (hasLocations && hasRepeatablePrefix) {
        diagnostics.push({
          checkId: "WFW112",
          severity: "info",
          message:
            "Both versioned and repeatable migration prefixes are configured for the same locations — consider using separate locations to improve migration clarity",
          entity: name,
          lexicon: "flyway",
        });
      }
    }

    return diagnostics;
  },
};
