/**
 * DKRD016: COPY --from names no earlier stage
 *
 * `COPY --from=<name>` reads from an earlier stage with that name (or
 * index). A name that only a later stage has, or that no stage has, is
 * pulled as an image instead, which is almost never what was meant.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile, stageLabel } from "./docker-helpers";

/** Looks like an image reference rather than a stage name: has a tag, digest or registry path. */
function looksLikeImage(ref: string): boolean {
  return /[:/@]/.test(ref);
}

export const dkrd016: PostSynthCheck = {
  id: "DKRD016",
  description: "COPY --from names a stage that is not defined before it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, parsed } of eachDockerfile(ctx.outputs)) {
      for (const stage of parsed.stages) {
        for (const instr of stage.instructions) {
          if (instr.instruction !== "COPY" && instr.instruction !== "ADD") continue;
          const m = instr.value.match(/--from=(\S+)/);
          if (!m) continue;
          const ref = m[1]!;
          if (ref.includes("$")) continue;
          const earlier = parsed.stages.slice(0, stage.index);
          if (/^\d+$/.test(ref)) {
            if (Number(ref) < stage.index) continue;
          } else if (earlier.some((s) => s.as?.toLowerCase() === ref.toLowerCase())) {
            continue;
          }
          const later = parsed.stages.slice(stage.index).find((s) => s.as?.toLowerCase() === ref.toLowerCase() || String(s.index) === ref);
          if (!later && looksLikeImage(ref)) continue;
          diagnostics.push({
            checkId: "DKRD016",
            severity: "warning",
            message: later
              ? `${fileName} ${stageLabel(stage)}: ${instr.instruction} --from=${ref} names ${stageLabel(later)}, which is not defined until later. Move that stage before this one.`
              : `${fileName} ${stageLabel(stage)}: ${instr.instruction} --from=${ref} names no stage, so Docker pulls an image called "${ref}". Name an earlier stage, or give the image a tag.`,
            lexicon: "docker",
          });
        }
      }
    }

    return diagnostics;
  },
};
