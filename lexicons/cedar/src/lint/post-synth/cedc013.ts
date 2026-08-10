/**
 * CEDC013: annotation hygiene on an emitted policy
 *
 * Annotations are Cedar's only metadata channel — no comments survive the JSON
 * grammar, and `policyToText` drops them — so `@id`, `@doc`, and friends are
 * the whole audit trail a policy carries into AVP or a review. Three things
 * make that trail useless:
 *
 * - an `@id` annotation that disagrees with the key the policy is filed under,
 *   so the text artifact and the JSON artifact name the same policy differently;
 * - an annotation whose value is empty, which reads as documented and is not;
 * - an annotation whose value is not a string, which Cedar's `Annotations`
 *   (`Record<string, string>`) does not admit.
 *
 * A *missing* `@id` is not a finding: chant derives one from the logical name,
 * which is the normal case and the one the serializer is built around.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { annotationsOf, parsedPolicySets } from "./cedar-helpers";

export const cedc013: PostSynthCheck = {
  id: "CEDC013",
  description: "An emitted policy's @id annotation must match its policy id, and annotation values must be non-empty strings",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const set of parsedPolicySets(ctx)) {
      for (const entry of set.entries) {
        const annotations = annotationsOf(entry.policy);

        for (const [key, value] of Object.entries(annotations)) {
          if (typeof value !== "string") {
            diagnostics.push({
              checkId: "CEDC013",
              severity: "warning",
              message: `Policy "${entry.key}" has a non-string @${key} annotation (${JSON.stringify(value)}). Cedar annotations are strings.`,
              entity: entry.key,
              lexicon: set.lexicon,
            });
            continue;
          }
          if (value.trim() === "") {
            diagnostics.push({
              checkId: "CEDC013",
              severity: "warning",
              message: `Policy "${entry.key}" has an empty @${key} annotation. Give it a value or drop it — an empty annotation reads as documentation and carries none.`,
              entity: entry.key,
              lexicon: set.lexicon,
            });
            continue;
          }
          if (key === "id" && value !== entry.key) {
            diagnostics.push({
              checkId: "CEDC013",
              severity: "warning",
              message: `Policy filed under id "${entry.key}" annotates @id("${value}"). The .cedar text and the JSON policy set would name this policy differently — make the annotation match, or remove it and let chant derive the id.`,
              entity: entry.key,
              lexicon: set.lexicon,
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
