/**
 * TF022: a credential-named attribute of a resource or data source holds a
 * literal.
 *
 * tfsec's `general-secrets-sensitive-in-attribute`, consolidated in its v1
 * line as `no-plaintext-exposure`, and KICS's `Passwords And Secrets` query.
 * Broader and noisier than TF007, because a resource body has far more
 * attributes than a variable has defaults, so the name heuristic does the
 * gating: an attribute has to read like a credential AND hold a committed
 * literal before it is reported.
 *
 * The value is in git history, in state, and in every plan output, and the
 * blast radius is whatever the resource is: an RDS master password, a
 * provider API token, a Kubernetes secret's data. The fix is always the same
 * shape, a reference rather than a constant, which is what the message says
 * rather than "remove this".
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
import { DATA_TYPE, RESOURCE_TYPE } from "../../hcl/parse";
import { isSecretName, secretShapedAssignment } from "../secret-shape";
import { blocksOfTypes, walkAttributes } from "./blocks";

export const tf022: PostSynthCheck = {
  id: "TF022",
  description: "Credential-named resource attribute holds a plaintext literal",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfTypes(ctx, [RESOURCE_TYPE, DATA_TYPE])) {
      for (const attr of walkAttributes(block.body)) {
        if (!isSecretName(attr.name)) continue;
        const shape = secretShapedAssignment(attr.name, attr.value);
        if (!shape) continue;

        diagnostics.push({
          checkId: "TF022",
          severity: "error",
          message:
            `"${block.address}" sets \`${attr.path}\` to a plaintext literal (${shape.length} ` +
            "characters, redacted here). The value is in git history, in state, and in plan output. " +
            "Replace it with a reference: a `sensitive` variable, or a data source that reads the " +
            "value from a secret manager at apply time.",
          entity: `${block.key}.${attr.path}`,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
