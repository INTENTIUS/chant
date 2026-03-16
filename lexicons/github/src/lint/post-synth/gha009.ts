/**
 * GHA009: Empty Matrix Dimension
 *
 * Detects matrix dimensions with empty values arrays.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "./yaml-helpers";

export const gha009: PostSynthCheck = {
  id: "GHA009",
  description: "Matrix dimension has empty values array",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      // Find matrix sections and check for empty arrays
      const matrixMatch = yaml.match(/matrix:\n([\s\S]*?)(?=\n\s{4}[a-z]|\n\s{2}[a-z]|\n[a-z]|$)/gm);
      if (!matrixMatch) continue;

      for (const section of matrixMatch) {
        const lines = section.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const keyMatch = lines[i].match(/^\s+([a-z][a-z0-9_-]*):\s*\[\s*\]\s*$/);
          if (keyMatch) {
            diagnostics.push({
              checkId: "GHA009",
              severity: "error",
              message: `Matrix dimension "${keyMatch[1]}" has an empty values array.`,
              lexicon: "github",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
