/**
 * Typed step-builder wrapper for this lexicon's `gitlabPipeline` activity
 * (chant #1288 Stage 2 — "regenerate the step builders as fully typed
 * wrappers"). Core cannot import a lexicon's `*Args` types (lexicons depend
 * on core, not the other way around), so a fully typed `gitlabPipeline` has
 * to live beside {@link GitlabPipelineArgs} — here, next to
 * `./activities/gitlab.ts`. `opts`'s type below IS `GitlabPipelineArgs`
 * itself (via `Omit`/`WithStepRefs`) — never a hand-restated mirror.
 *
 * `core`'s own `gitlabPipeline` (in `@intentius/chant/op`, re-exported from
 * `@intentius/chant-lexicon-temporal`) is UNCHANGED and produces a
 * byte-identical `ActivityStep` for the same inputs — purely additive, and
 * deliberately not swapped into the temporal barrel (see
 * `lexicons/k8s/src/op/builders.ts`'s module doc for why: that would make
 * temporal depend on this package at runtime). An author who wants the typed
 * surface imports it from here — `@intentius/chant-lexicon-gitlab`.
 */

import {
  activity,
  takeProfileAndId,
  type ActivityStep,
  type NamedActivityStep,
  type WithStepRefs,
} from "@intentius/chant/op";
import type { GitlabPipelineArgs } from "./activities/gitlab";

/**
 * Trigger and wait for a GitLab CI pipeline to complete — the fully typed
 * twin of core's `gitlabPipeline`. `opts` is {@link GitlabPipelineArgs}
 * itself, minus the positional `name`. Defaults to the `longInfra` profile.
 */
export const gitlabPipeline = (
  name: string,
  opts?: WithStepRefs<Omit<GitlabPipelineArgs, "name">> & { profile?: ActivityStep["profile"]; id?: string },
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown> | undefined);
  return activity("gitlabPipeline", { name, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};
