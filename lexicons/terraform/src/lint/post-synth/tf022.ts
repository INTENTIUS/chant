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
 * An argument that names a secret instead of holding one is skipped: the
 * `secret` of a Secret Manager version data source is the id of the secret to
 * read, and reading it at apply time is the fix (#5080). The skip is a table
 * of types and attribute paths in `../secret-shape.ts`, not a rule about the
 * word `secret`, so the same name on a type outside it is still judged.
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
import { isSecretName, isSecretReferenceArgument, secretShapedAssignment } from "../secret-shape";
import { blocksOfTypes, walkAttributes } from "./blocks";

/** `data.google_x.y` and `google_x.y` both give `google_x`. */
function terraformTypeOf(address: string): string {
  const bare = address.startsWith("data.") ? address.slice("data.".length) : address;
  const dot = bare.indexOf(".");
  return dot === -1 ? bare : bare.slice(0, dot);
}

export const tf022: PostSynthCheck = {
  id: "TF022",
  description: "Credential-named resource attribute holds a plaintext literal",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfTypes(ctx, [RESOURCE_TYPE, DATA_TYPE])) {
      const blockType = terraformTypeOf(block.address);
      for (const attr of walkAttributes(block.body)) {
        if (!isSecretName(attr.name)) continue;
        // `secret` on a Secret Manager version data source is the id of the
        // secret to read, which is the fix this rule asks for (#5080).
        if (isSecretReferenceArgument(blockType, attr.path)) continue;
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
          entity: block.key,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
