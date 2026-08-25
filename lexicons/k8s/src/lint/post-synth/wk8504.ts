/**
 * WK8504: committed-encrypted secret declaration does not resolve
 *
 * `declareSecret({ provenance: "committed-encrypted", file })` is a claim
 * about an artifact INSIDE the build, which is what separates it from the
 * three kinds that promise something outside one. A claim inside the build
 * should be verified rather than taken on trust, and this is the check that
 * makes it falsifiable: it fires when the declared file produced no sidecar,
 * when the emitted document is not a `v1` Secret of the declared name, when
 * it carries no `sops` block, or when a `data`/`stringData` value is not
 * `ENC[...]`-shaped.
 *
 * That last case is the failure this rule exists for: someone edits
 * `db-credentials.sops.yaml` by hand, forgets `sops -e`, and commits
 * plaintext. Before this, nothing in chant would notice.
 *
 * It reads `output.files`, not `getPrimaryOutput`. The ciphertext is
 * deliberately kept out of the primary output — that is what makes applying
 * an undecrypted Secret structurally impossible — so every other post-synth
 * check in the lexicon is blind to it by construction, and this one has to
 * ask for the sidecars explicitly.
 *
 * A value is only ever tested for the `ENC[` prefix; the message names the
 * offending KEY, never what was found there.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { resolveEncryptedSecretClaims } from "./sops-helpers";

export const wk8504: PostSynthCheck = {
  id: "WK8504",
  description:
    "committed-encrypted secret declaration does not resolve — the declared file is missing, is not the named Secret, or is not encrypted",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const claim of resolveEncryptedSecretClaims(ctx)) {
      for (const problem of claim.problems) {
        diagnostics.push({
          checkId: "WK8504",
          severity: "error",
          message: `declareSecret("${claim.declaration.name}"): ${problem}`,
          entity: claim.declaration.name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
