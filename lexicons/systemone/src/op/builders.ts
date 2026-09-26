/**
 * The typed step builder for this lexicon's `decide` activity. `opts` is the
 * activity's own {@link DecideArgs}, minus the positional `point`, so the
 * builder and the activity cannot drift.
 */

import { activity, takeProfileAndId, type ActivityStep, type NamedActivityStep, type WithStepRefs } from "@intentius/chant/op";
import type { DecideArgs } from "./activities/decide";

type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Ask a decision point and record its answer. Defaults to the `fastIdempotent`
 * profile: asking again with the same point, declaration and inputs returns
 * the record already written.
 *
 * ```ts
 * decide("slice-tier", { read: { "work-item": "W-002" }, subject: "W-002" })
 * ```
 */
export const decide = (point: string, opts?: WithStepRefs<Omit<DecideArgs, "point">> & StepOpts): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("decide", { point, ...args }, { profile: profile ?? "fastIdempotent", ...(id ? { id } : {}) });
};
