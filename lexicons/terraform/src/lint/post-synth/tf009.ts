/**
 * TF009: a credential-named variable is not marked `sensitive`.
 *
 * No tool in #2107's survey checks this. The authority is HashiCorp's own style
 * guide, whose variables section says plainly: "For sensitive variables, such
 * as passwords and private keys, set the sensitive parameter to true."
 *
 * Without the flag the value is echoed in `terraform plan` and
 * `terraform apply` output, which means it lands in CI logs, in the pull
 * request comment a plan bot posts, and in every terminal scrollback. The flag
 * does not keep the value out of state (nothing does), which is why the
 * remediation says both things.
 *
 * Only the name is read. A variable with no default and no value in the
 * repository is still flagged, because the finding is about where the value
 * goes at run time, not about what is committed. That is TF007's question.
 *
 * Scope: root and child modules alike (#2112). The condition is a property
 * of the block itself, so a descended module's block is read exactly as a
 * root's is.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { VARIABLE_TYPE } from "../../hcl/parse";
import { isSecretName } from "../secret-shape";
import { blockName, blocksOfType } from "./blocks";

export const tf009: PostSynthCheck = {
  id: "TF009",
  description: "Credential-named variable is not marked sensitive",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, VARIABLE_TYPE)) {
      const name = blockName(block.address);
      if (!isSecretName(name)) continue;
      if (block.body.sensitive === true) continue;

      diagnostics.push({
        checkId: "TF009",
        severity: "error",
        message:
          `Variable "${name}" is named like a credential but is not marked \`sensitive = true\`, so ` +
          "Terraform prints its value in plan and apply output, and from there into CI logs and plan " +
          "comments. Add `sensitive = true`, and remember the value is still stored in plaintext in " +
          "state either way.",
        entity: block.key,
        lexicon: "terraform",
      });
    }

    return diagnostics;
  },
};
