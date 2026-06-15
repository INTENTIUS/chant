/**
 * WFJ010: Unresolved action reference.
 *
 * After the forgejo dialect runs, every `uses:` should be a Forgejo-resolvable
 * form (a full URL, a local `./` action, or `docker://`). A bare `owner/repo@ref`
 * that survives into the output won't resolve — Forgejo has no GitHub
 * Marketplace. Flags it so it's caught in `chant lint` / `forgejo:checks`, not
 * only as a build-time warning.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";
import { extractActionRefs } from "@intentius/chant-lexicon-github/lint/post-synth/yaml-helpers";
import { resolveActionRef } from "../../actions";

export const wfj010: PostSynthCheck = {
  id: "WFJ010",
  description: "Unresolved action reference (won't resolve on Forgejo)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const ref of extractActionRefs(yaml)) {
        if (resolveActionRef(ref.ref).warning) {
          diagnostics.push({
            checkId: "WFJ010",
            severity: "warning",
            message: `Job "${ref.job}" references '${ref.ref}', which has no Forgejo-resolvable form. Use a full repository URL or map it under forgejo.actionsRoot.`,
            entity: ref.job,
            lexicon: "forgejo",
          });
        }
      }
    }
    return diagnostics;
  },
};
