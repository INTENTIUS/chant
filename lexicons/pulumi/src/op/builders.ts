/**
 * Typed step builders for this lexicon's activities (#4494), in the shape of
 * `lexicons/terraform/src/op/builders.ts`: `opts` is the activity's own
 * `*Args` interface minus the positional `member`, so renaming a field on the
 * activity stops its callers compiling. `id` routes to the step's `id`, and
 * both default to the `longInfra` profile, since a preview and a refresh call
 * every provider the stack uses.
 */
import { activity, takeProfileAndId, type ActivityStep, type NamedActivityStep, type WithStepRefs } from "@intentius/chant/op";
import type { PulumiDriftArgs, PulumiPreviewArgs } from "./activities/pulumi";
import type { PulumiAdoptArgs, PulumiAdoptCheckArgs, PulumiAdoptExportArgs, PulumiAdoptPreviewArgs } from "./activities/pulumi-adopt";

type StepOpts = { profile?: ActivityStep["profile"]; id?: string };

/** `pulumi preview --json` for the named member: the typed twin of the `pulumiPreview` activity. */
export const pulumiPreview = (
  member: string,
  opts: WithStepRefs<Omit<PulumiPreviewArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiPreview", { member, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/** The member's drift read: the typed twin of the `pulumiDrift` activity. */
export const pulumiDrift = (
  member: string,
  opts: WithStepRefs<Omit<PulumiDriftArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiDrift", { member, ...args }, { profile: profile ?? "longInfra", ...(id ? { id } : {}) });
};

/** The shared bucket check before adoption (#4562): the typed twin of `pulumiAdoptCheck`. */
export const pulumiAdoptCheck = (
  member: string,
  opts: WithStepRefs<Omit<PulumiAdoptCheckArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiAdoptCheck", { member, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};

/** The stock checkpoint's export (#4562): the typed twin of `pulumiAdoptExport`. */
export const pulumiAdoptExport = (
  member: string,
  opts: WithStepRefs<Omit<PulumiAdoptExportArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiAdoptExport", { member, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};

/** `plunge stack adopt --json` (#4562): the typed twin of `pulumiAdoptPreview`. */
export const pulumiAdoptPreview = (
  member: string,
  opts: WithStepRefs<Omit<PulumiAdoptPreviewArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiAdoptPreview", { member, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};

/** `plunge stack adopt --json --yes` (#4562): the typed twin of `pulumiAdopt`. */
export const pulumiAdopt = (
  member: string,
  opts: WithStepRefs<Omit<PulumiAdoptArgs, "member">> & StepOpts,
): NamedActivityStep => {
  const { args, profile, id } = takeProfileAndId(opts as Record<string, unknown>);
  return activity("pulumiAdopt", { member, ...args }, { ...(profile ? { profile } : {}), ...(id ? { id } : {}) });
};
