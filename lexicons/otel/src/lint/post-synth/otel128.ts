/**
 * OTEL128: The collector config uses a component the declared Distribution does not build
 *
 * When a project declares a `Distribution` (an ocb builder manifest), every component a collector config declares must be one the distribution builds; a collector built from it fails at start with "unknown type" otherwise. A project without a `Distribution` is not checked.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { distributionIssues, isDistributionEntity } from "../../distribution";
import { collectorConfigs, toDiagnostic } from "./otel-helpers";

export const otel128: PostSynthCheck = {
  id: "OTEL128",
  description: "The collector config uses a component the declared Distribution does not build",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const dist = [...(ctx.entities?.values() ?? [])].find(isDistributionEntity);
    if (!dist) return [];
    return collectorConfigs(ctx).flatMap(({ config, ...found }) =>
      distributionIssues(config, dist).map((i) => toDiagnostic(i, found)),
    );
  },
};
