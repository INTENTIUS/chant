import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf, readArray } from "../../entity-props";
import { GVC, POLICY, entitiesOfType } from "./helpers";

/**
 * CPL013: an identity principal link that Control Plane will ignore.
 *
 * `//identity/NAME` is accepted by the policy API and then has no effect. Only
 * the GVC-qualified `//gvc/GVC/identity/NAME` grants anything. Nothing reports
 * this — the policy exists, the binding exists, and the permission is simply
 * never granted.
 */
export const qualifiedIdentityPrincipalCheck: PostSynthCheck = {
  id: "CPL013",
  description: "Policy bindings must name identities by their GVC-qualified link",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of entitiesOfType(ctx.entities, POLICY)) {
      for (const binding of readArray(entity, "bindings")) {
        const links = propsOf(binding).principalLinks;
        if (!Array.isArray(links)) continue;

        for (const link of links) {
          if (typeof link !== "string") continue;
          if (!/^\/\/identity\/[^/]+$/.test(link)) continue;

          diagnostics.push({
            checkId: "CPL013",
            severity: "error",
            message:
              `Policy "${name}" binds the principal "${link}". Control Plane silently ignores the bare ` +
              `//identity/NAME form — use //gvc/<gvc>/identity/${link.slice("//identity/".length)} instead. ` +
              `The policy will apply cleanly and grant nothing as written.`,
            entity: name,
            lexicon: "cpln",
          });
        }
      }
    }

    return diagnostics;
  },
};
