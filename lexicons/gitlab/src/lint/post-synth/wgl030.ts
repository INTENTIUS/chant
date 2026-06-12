/**
 * WGL030: Mutable or Insecure include:remote
 *
 * Flags `include:remote` URLs that are fetched over HTTP (no transport
 * integrity) or over HTTPS but inherently mutable (a raw URL can be repointed
 * at any time). Prefer `include:project` pinned to a tag/SHA, or a pinned
 * component, over a remote URL. Generalizes WGL017 (non-HTTPS) to includes.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIncludes } from "./yaml-helpers";

export const wgl030: PostSynthCheck = {
  id: "WGL030",
  description: "include:remote is insecure (HTTP) or mutable",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const entry of extractIncludes(yaml)) {
        const isRemote = entry.kind === "remote" || (entry.kind === "string" && /^https?:\/\//.test(entry.value));
        if (!isRemote) continue;

        if (/^http:\/\//.test(entry.value)) {
          diagnostics.push({
            checkId: "WGL030",
            severity: "error",
            message: `include:remote "${entry.value}" is fetched over HTTP — an attacker on the network can swap the included config. Use HTTPS, and prefer a pinned include:project or component.`,
            entity: entry.value,
            lexicon: "gitlab",
          });
        } else {
          diagnostics.push({
            checkId: "WGL030",
            severity: "warning",
            message: `include:remote "${entry.value}" is a mutable URL — its contents can change after review. Prefer include:project pinned to a tag/SHA, or a pinned component.`,
            entity: entry.value,
            lexicon: "gitlab",
          });
        }
      }
    }

    return diagnostics;
  },
};
