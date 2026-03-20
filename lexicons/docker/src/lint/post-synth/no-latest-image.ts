/**
 * DKRD001: No Latest Image Tag
 *
 * Detects services using :latest or untagged images in docker-compose.yml.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractServices, isLatestOrUntagged } from "./docker-helpers";

export const dkrd001: PostSynthCheck = {
  id: "DKRD001",
  description: "Service uses :latest or untagged image — specify an explicit version tag",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      if (!yaml) continue;

      const services = extractServices(yaml);
      for (const [name, svc] of services) {
        if (svc.image && isLatestOrUntagged(svc.image)) {
          diagnostics.push({
            checkId: "DKRD001",
            severity: "warning",
            message: `Service "${name}" uses image "${svc.image}" which is :latest or untagged. Use an explicit version tag for reproducible builds.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
