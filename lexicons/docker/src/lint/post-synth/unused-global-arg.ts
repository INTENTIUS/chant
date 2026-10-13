/**
 * DKRD017: ARG before FROM that nothing uses
 *
 * An ARG declared before the first FROM is only visible to FROM lines, and
 * to stages that declare it again (`ARG NAME`). One that neither uses does
 * nothing.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { eachDockerfile } from "./docker-helpers";

export const dkrd017: PostSynthCheck = {
  id: "DKRD017",
  description: "ARG before the first FROM is not used by any FROM or stage",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const { fileName, content, parsed } of eachDockerfile(ctx.outputs)) {
      const fromLines = content.split("\n").filter((l) => /^\s*FROM\s/i.test(l)).join("\n");
      for (const arg of parsed.globalArgs) {
        const name = arg.value.trim().split("=")[0]!.trim();
        if (!name) continue;
        const used = new RegExp(`\\$\\{?${name}\\b`).test(fromLines);
        const redeclared = parsed.stages.some((s) => s.instructions.some((i) => i.instruction === "ARG" && i.value.trim().split("=")[0]!.trim() === name));
        if (used || redeclared) continue;
        diagnostics.push({
          checkId: "DKRD017",
          severity: "warning",
          message: `${fileName}: ARG ${name} is declared before FROM but no FROM uses it and no stage declares it again with ARG ${name}. Use it, declare it in the stage that needs it, or remove it.`,
          lexicon: "docker",
        });
      }
    }

    return diagnostics;
  },
};
