/**
 * Typed step builder for this lexicon's activity (chant #1288 Stage 2),
 * beside its `*Args` interface for the reason `lexicons/k8s/src/op/builders.ts`
 * gives: core cannot import a lexicon's types. `opts` is
 * {@link GrafanaApplyArgs} itself (via `Omit`/`WithStepRefs`), never
 * restated.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { GrafanaApplyArgs } from "./activities/grafana-apply";

/** Extra opts the builder accepts alongside the activity's own fields. */
type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/**
 * Apply a grafana build to the environment's Grafana over its HTTP API
 * (#2948): folders, library panels and dashboards, stamped with chant's
 * ownership labels, and with `prune`, this project's orphans deleted.
 * `opts` is {@link GrafanaApplyArgs} minus the positional `indexPath`.
 * Defaults to the `longInfra` profile, as the other API appliers do.
 */
export const grafanaApply = (
  indexPath: string,
  opts?: WithStepRefs<Omit<GrafanaApplyArgs, "indexPath">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("grafanaApply", { indexPath, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};
