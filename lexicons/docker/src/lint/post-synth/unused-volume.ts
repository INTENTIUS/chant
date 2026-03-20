/**
 * DKRD002: Unused Named Volume
 *
 * Detects top-level named volumes that are not mounted by any service.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractServices, extractNamedVolumes } from "./docker-helpers";

export const dkrd002: PostSynthCheck = {
  id: "DKRD002",
  description: "Named volume is declared but not mounted by any service",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_outputName, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      if (!yaml) continue;

      const namedVolumes = extractNamedVolumes(yaml);
      if (namedVolumes.size === 0) continue;

      const services = extractServices(yaml);
      const mountedVolumes = new Set<string>();

      for (const svc of services.values()) {
        for (const vol of svc.volumes ?? []) {
          // Volume mount format: "volname:/container/path" or just "volname"
          const volumeName = vol.split(":")[0].trim();
          mountedVolumes.add(volumeName);
        }
      }

      for (const volName of namedVolumes) {
        if (!mountedVolumes.has(volName)) {
          diagnostics.push({
            checkId: "DKRD002",
            severity: "warning",
            message: `Named volume "${volName}" is declared but not mounted by any service.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
