/**
 * WGL033: OIDC id_token Without a Scoped Audience
 *
 * Flags an `id_tokens:` declaration with no `aud:` or a wildcard audience. The
 * audience binds the minted OIDC token to a specific relying party; without it
 * (or with `*`), a leaked token is accepted anywhere, defeating the point of
 * short-lived federated identity. Set `aud:` to the exact audience(s) needed.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIdTokens } from "./yaml-helpers";

export const wgl033: PostSynthCheck = {
  id: "WGL033",
  description: "OIDC id_token without a scoped audience",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, name, aud } of extractIdTokens(yaml)) {
        const broad = aud.length === 0 || aud.some((a) => a === "*" || a === "" || a.includes("*"));
        if (broad) {
          diagnostics.push({
            checkId: "WGL033",
            severity: "warning",
            message: `Job "${job}" id_token "${name}" has ${aud.length === 0 ? "no aud:" : "a wildcard audience"}. Scope it to the exact audience the relying party expects so a leaked token cannot be used elsewhere.`,
            entity: job,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
