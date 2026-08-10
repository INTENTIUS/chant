/**
 * CEDC012: no two policies may claim the same id
 *
 * A Cedar policy id is the handle everything downstream uses: the validator
 * reports against it, AVP's `CreatePolicy` stores it, a drift check diffs on
 * it. chant derives one from the logical name (`allowAdminRead` →
 * `allow-admin-read`) unless the author sets `annotations.id` explicitly, and
 * two policies can land on the same string either way — a rename that
 * kebab-cases to something already taken, or the same explicit `@id` pasted
 * twice.
 *
 * The consequence is silent. The `.cedar` text gets two policies carrying
 * `@id("same")`, while the JSON envelope is keyed by id and keeps only the last
 * one — a policy that exists in the artifact a human reviews and not in the one
 * a machine loads. Ids are collected from every policy set in the build, from
 * both the envelope key and the `@id` annotation, so a collision is caught
 * whichever of the two forms it takes.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { annotatedId, parsedPolicySets } from "./cedar-helpers";

interface Claim {
  lexicon: string;
  source: string;
  /** The envelope key the claim was made under. */
  key: string;
}

export const cedc012: PostSynthCheck = {
  id: "CEDC012",
  description: "No two emitted Cedar policies may claim the same policy id",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const claims = new Map<string, Claim[]>();

    for (const set of parsedPolicySets(ctx)) {
      for (const entry of set.entries) {
        // The key and the `@id` annotation are two ways of claiming the same
        // id; a policy claiming both only counts once.
        const ids = new Set([entry.key, annotatedId(entry.policy)].filter((id): id is string => !!id));
        for (const id of ids) {
          const existing = claims.get(id) ?? [];
          existing.push({ lexicon: set.lexicon, source: set.source, key: entry.key });
          claims.set(id, existing);
        }
      }
    }

    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [id, holders] of [...claims].sort(([a], [b]) => a.localeCompare(b))) {
      if (holders.length < 2) continue;
      const where = holders.map((h) => `${h.source}:${h.key}`).join(", ");
      diagnostics.push({
        checkId: "CEDC012",
        severity: "error",
        message: `Cedar policy id "${id}" is claimed by ${holders.length} policies (${where}). Ids must be unique across the policy set — rename one of the declarations or give it an explicit, distinct @id annotation.`,
        entity: id,
        lexicon: holders[0].lexicon,
      });
    }

    return diagnostics;
  },
};
