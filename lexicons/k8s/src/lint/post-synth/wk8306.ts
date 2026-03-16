/**
 * WK8306: Container Command Starts With Flag
 *
 * If `command[0]` starts with `-` or `--`, it's almost certainly a mistake —
 * the first element should be the binary/entrypoint, flags belong in `args`.
 * This causes OCI runtime errors because the container runtime tries to
 * execute the flag as a binary.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseK8sManifests, extractContainers, WORKLOAD_KINDS } from "./k8s-helpers";

export const wk8306: PostSynthCheck = {
  id: "WK8306",
  description: "Container command starts with flag — first element should be a binary, not a flag",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const manifests = parseK8sManifests(yaml);

      for (const manifest of manifests) {
        if (!manifest.kind || !WORKLOAD_KINDS.has(manifest.kind)) continue;

        const resourceName = manifest.metadata?.name ?? manifest.kind;
        const containers = extractContainers(manifest);

        for (const container of containers) {
          const command = (container as Record<string, unknown>).command as unknown[] | undefined;
          if (!Array.isArray(command) || command.length === 0) continue;

          const firstArg = String(command[0]);
          if (firstArg.startsWith("-")) {
            diagnostics.push({
              checkId: "WK8306",
              severity: "error",
              message: `Container "${container.name ?? "(unnamed)"}" in ${manifest.kind} "${resourceName}" has command[0]="${firstArg}" which starts with a flag — the first element should be the binary, flags belong in args`,
              entity: resourceName,
              lexicon: "k8s",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
