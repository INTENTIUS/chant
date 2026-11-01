/**
 * FLY012: a Machine's `schedule` is one the Machines API runs (#4696).
 *
 * Fly runs a scheduled Machine `hourly`, `daily`, `weekly` or `monthly`, and
 * rejects anything else when the Machine is created or updated. A cron
 * expression is the usual mistake, so name the four values at build time
 * rather than at the first release.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readProps, entityTypeOf } from "./fly-helpers";

const SCHEDULES = ["hourly", "daily", "weekly", "monthly"];

export const fly012: PostSynthCheck = {
  id: "FLY012",
  description: "Machine schedule must be hourly, daily, weekly or monthly",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [name, entity] of ctx.entities) {
      if (entityTypeOf(entity) !== "Fly::Machines::Machine") continue;
      const config = readProps(entity).config;
      if (!config) continue;
      const schedule = readProps(config).schedule;
      if (schedule === undefined) continue;
      if (typeof schedule !== "string" || !SCHEDULES.includes(schedule)) {
        diagnostics.push({
          checkId: "FLY012",
          severity: "error",
          message: `Machine "${name}" has schedule ${JSON.stringify(schedule)}; Fly runs a Machine ${SCHEDULES.join(", ")}`,
          entity: name,
          lexicon: "fly",
        });
      }
    }
    return diagnostics;
  },
};
