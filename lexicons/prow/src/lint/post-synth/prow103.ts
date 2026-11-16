/**
 * PROW103: a job with no pod spec.
 *
 * A job's agent is `kubernetes` unless it names another, and Prow's config
 * loader refuses a kubernetes job without `spec`, and a pod spec with no
 * container. A tekton-pipeline or jenkins job runs no pod spec, so the
 * check leaves those alone.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { builtJobConfigs, nameOf } from "./prow-helpers";

export const prow103: PostSynthCheck = {
  id: "PROW103",
  description: "A kubernetes job without a pod spec or without a container, which Prow's config loader refuses",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const { source, jobs } of builtJobConfigs(ctx)) {
      for (const j of jobs) {
        const agent = j.job.agent ?? "kubernetes";
        if (agent !== "kubernetes") continue;
        const spec = j.job.spec as { containers?: unknown } | undefined;
        const containers = spec && Array.isArray(spec.containers) ? spec.containers.length : 0;
        if (spec && containers > 0) continue;
        out.push({
          checkId: "PROW103",
          severity: "error",
          message: spec
            ? `${source}: ${j.type} ${nameOf(j)}'s pod spec has no container, and Prow's config loader needs at least one.`
            : `${source}: ${j.type} ${nameOf(j)} has no spec, and Prow's config loader refuses a kubernetes job without a pod spec.`,
          entity: nameOf(j),
          lexicon: "prow",
        });
      }
    }
    return out;
  },
};
