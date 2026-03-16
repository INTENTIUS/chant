/**
 * WGC102: Public IAM in serialized output
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

export const wgc102: PostSynthCheck = {
  id: "WGC102",
  description: "allUsers/allAuthenticatedUsers detected in serialized Config Connector YAML",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      if (typeof output !== "string") continue;

      const lines = output.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes("allUsers") || line.includes("allAuthenticatedUsers")) {
          const member = line.includes("allUsers") ? "allUsers" : "allAuthenticatedUsers";
          diagnostics.push({
            checkId: "WGC102",
            severity: "warning",
            message: `Public IAM member "${member}" found in output (line ${i + 1}) — this grants public access`,
            entity: `line:${i + 1}`,
            lexicon: "gcp",
          });
        }
      }
    }

    return diagnostics;
  },
};
