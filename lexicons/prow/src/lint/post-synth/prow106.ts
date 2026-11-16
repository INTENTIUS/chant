/**
 * PROW106: a job that sets always_run beside a change filter, or both
 * change filters.
 *
 * Prow's config loader refuses a presubmit or postsubmit with `always_run:
 * true` and `run_if_changed` or `skip_if_only_changed`, and one with both
 * `run_if_changed` and `skip_if_only_changed`: each decides on its own when
 * the job runs.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { builtJobConfigs, nameOf } from "./prow-helpers";

const set = (v: unknown): boolean => typeof v === "string" && v !== "";

export const prow106: PostSynthCheck = {
  id: "PROW106",
  description: "A job with always_run and a change filter, or both change filters, which Prow's config loader refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      for (const j of jobs) {
        if (j.type === "periodic") continue;
        const filters = (["run_if_changed", "skip_if_only_changed"] as const).filter((k) => set(j.job[k]));
        const clash = j.job.always_run === true && filters.length > 0 ? ["always_run", ...filters] : filters.length === 2 ? filters : [];
        if (clash.length === 0) continue;
        out.push({
          checkId: "PROW106",
          severity: "error",
          message: `${source}: ${j.type} ${nameOf(j)} sets ${clash.join(" and ")}, which Prow's config loader refuses together: keep one way of saying when the job runs.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
