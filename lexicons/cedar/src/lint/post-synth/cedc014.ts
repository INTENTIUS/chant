/**
 * CEDC014: a scope constraint's entity reference must be a real entity UID
 *
 * Cedar names an entity as `Namespace::Type::"id"` — a type path and a quoted
 * id. chant's serializer splits an authored reference on that grammar, and a
 * reference that does not match it degrades rather than fails: the whole string
 * becomes the type and the id becomes empty. `principal: { eq: "alice" }`
 * therefore emits `{"op":"==","entity":{"type":"alice","id":""}}` — a policy
 * that parses, validates against a schema that happens to define no such type
 * only as an "unrecognized entity type", and silently matches nothing at
 * runtime if it ever does.
 *
 * An empty entity id is the fingerprint of that degradation, and there is no
 * legitimate reason to author one, so it is flagged wherever it appears in a
 * scope: `== E`, `in E`, `in [E, …]`, and the `in` of an `is T in E`.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isRecord, parsedPolicySets, scopesOf, type CedarScopeJson } from "./cedar-helpers";

/** Every entity reference a scope position carries, in document order. */
function scopeEntities(scope: CedarScopeJson): unknown[] {
  const found: unknown[] = [];
  const collect = (holder: unknown): void => {
    if (!isRecord(holder)) return;
    if (holder.entity !== undefined) found.push(holder.entity);
    if (Array.isArray(holder.entities)) found.push(...holder.entities);
  };
  collect(scope);
  // `is T in E` nests the `in` constraint under the `is`.
  collect(scope.in);
  return found;
}

export const cedc014: PostSynthCheck = {
  id: "CEDC014",
  description: "An entity reference in a policy scope must be a well-formed Namespace::Type::\"id\" UID",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const set of parsedPolicySets(ctx)) {
      for (const entry of set.entries) {
        for (const { variable, scope } of scopesOf(entry.policy)) {
          for (const ref of scopeEntities(scope)) {
            if (!isRecord(ref)) {
              diagnostics.push({
                checkId: "CEDC014",
                severity: "error",
                message: `Policy "${entry.key}" has a ${variable} constraint whose entity reference is not an entity UID (${JSON.stringify(ref)}).`,
                entity: entry.key,
                lexicon: set.lexicon,
              });
              continue;
            }
            const type = typeof ref.type === "string" ? ref.type : "";
            const id = typeof ref.id === "string" ? ref.id : undefined;
            if (type === "" || id === undefined || id === "") {
              diagnostics.push({
                checkId: "CEDC014",
                severity: "error",
                message: `Policy "${entry.key}" constrains ${variable} against "${type}" with no entity id. Write the reference as a full UID — Namespace::Type::"id" — so it resolves to an entity rather than to a bare type name.`,
                entity: entry.key,
                lexicon: set.lexicon,
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
