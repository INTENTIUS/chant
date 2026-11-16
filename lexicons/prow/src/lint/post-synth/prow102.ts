/**
 * PROW102: a periodic with no schedule, or with more than one.
 *
 * Prow's config loader refuses a periodic that sets none of `interval`,
 * `cron` and `minimum_interval`, and one that sets more than one: they are
 * the periodic's one schedule.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { builtJobConfigs, nameOf } from "./prow-helpers";

const SCHEDULE = ["interval", "cron", "minimum_interval"] as const;

export const prow102: PostSynthCheck = {
  id: "PROW102",
  description: "A periodic without exactly one of interval, cron and minimum_interval, which Prow's config loader refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      for (const j of jobs) {
        if (j.type !== "periodic") continue;
        const set = SCHEDULE.filter((k) => typeof j.job[k] === "string" && j.job[k] !== "");
        if (set.length === 1) continue;
        out.push({
          checkId: "PROW102",
          severity: "error",
          message:
            set.length === 0
              ? `${source}: periodic ${nameOf(j)} has no schedule. Prow's config loader needs one of interval, cron or minimum_interval.`
              : `${source}: periodic ${nameOf(j)} sets ${set.join(" and ")}, and Prow's config loader takes only one of interval, cron and minimum_interval.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
