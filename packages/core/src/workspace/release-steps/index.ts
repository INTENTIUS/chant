/**
 * The features of the release workflow (#5196), one file each. The frame in
 * ../release-workflow.ts asks each for its setup steps and its steps in the
 * cut and publish jobs; where they land is in the feature, so adding one adds
 * a file here and a line to the list below, kept in alphabetical order.
 */
import { artifactsFeature } from "./artifacts";
import { buildsFeature } from "./builds";
import { doctorFeature } from "./doctor";
import { goreleaserFeature } from "./goreleaser";
import { greenFeature } from "./green";
import { imagesFeature } from "./images";
import { nfpmFeature } from "./nfpm";
import { nugetFeature } from "./nuget";
import { pypiFeature } from "./pypi";
import { qemuFeature } from "./qemu";
import { signingFeature } from "./signing";
import { stampFeature } from "./stamp";
import { targetsFeature } from "./targets";
import { verifyFeature } from "./verify";
import type { OpSetupStep } from "../../lexicon";
import type { ReleaseStepContext, ReleaseStepItem, ReleaseStepSlot, ReleaseWorkflowContext, ReleaseWorkflowFeature } from "./types";

export type * from "./types";

/** Every feature, alphabetically by file. */
export const RELEASE_WORKFLOW_FEATURES: readonly ReleaseWorkflowFeature[] = [
  artifactsFeature,
  buildsFeature,
  doctorFeature,
  goreleaserFeature,
  greenFeature,
  imagesFeature,
  nfpmFeature,
  nugetFeature,
  pypiFeature,
  qemuFeature,
  signingFeature,
  stampFeature,
  targetsFeature,
  verifyFeature,
];

/** The setup steps of the cut and publish jobs: the features' and `release.workflow.setup` (order 20), lowest order first. */
export function releaseSetupSteps(c: ReleaseWorkflowContext, features: readonly ReleaseWorkflowFeature[] = RELEASE_WORKFLOW_FEATURES): OpSetupStep[] {
  const parts = [{ order: 20, steps: c.pipeline.setup ?? [] }, ...features.flatMap((f) => f.setup?.(c) ?? [])];
  return parts.sort((a, b) => a.order - b.order).flatMap((p) => p.steps);
}

/** One job's steps by slot, each slot's in order (lowest first, ties in list order). */
export function releaseJobSteps(c: ReleaseStepContext, features: readonly ReleaseWorkflowFeature[] = RELEASE_WORKFLOW_FEATURES): (slot: ReleaseStepSlot) => ReleaseStepItem[] {
  const placed = features.flatMap((f) => f.steps?.(c) ?? []);
  return (slot) =>
    placed
      .filter((p) => p.slot === slot)
      .sort((a, b) => a.order - b.order)
      .flatMap((p) => p.items);
}
