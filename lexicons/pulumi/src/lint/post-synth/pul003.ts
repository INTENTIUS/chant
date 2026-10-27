/**
 * PUL003: the stack export holds secrets in plaintext.
 *
 * `pulumi stack export` writes each secret as an envelope holding its
 * `ciphertext`, encrypted with the stack's secrets provider. With
 * `--show-secrets` it writes the same envelope with `plaintext` instead. The
 * export chant reads is checked in, so an export taken with `--show-secrets`
 * puts every secret value of the stack into the repository's history.
 *
 * An error: the leak is in the repository whether or not chant reads it, and
 * re-exporting without `--show-secrets` (and rotating what leaked) is the
 * fix. chant never copies inputs or outputs into the graph, so the graph
 * itself carries none of them.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { PULUMI_EXPORT_FILE } from "../../workspace-member";
import { entityOf, finding, listed, memberExport, plaintextSecretPaths } from "./member-read-helpers";

export const pul003: PostSynthCheck = {
  id: "PUL003",
  description: "The pulumi member's stack export holds secret values in plaintext (exported with --show-secrets)",

  check(_ctx: PostSynthContext): PostSynthDiagnostic[] {
    const exp = memberExport();
    if (!exp) return [];
    const out: PostSynthDiagnostic[] = [];
    for (const r of exp.resources) {
      const paths = plaintextSecretPaths(r);
      if (paths.length === 0) continue;
      out.push(
        finding(
          "PUL003",
          "error",
          `${PULUMI_EXPORT_FILE} holds ${paths.length} secret value(s) of ${r.urn} in plaintext (${listed(paths)}): ` +
            `it was exported with --show-secrets. Export again with \`pulumi stack export --file ${PULUMI_EXPORT_FILE}\` ` +
            `(no --show-secrets), and rotate the secrets the committed file exposed.`,
          entityOf(exp.read, r.urn),
        ),
      );
    }
    return out;
  },
};
