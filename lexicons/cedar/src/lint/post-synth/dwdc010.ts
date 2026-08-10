/**
 * DWDC010: a temporal predicate must name an event kind the schema declares
 *
 * Upstream rejects this outright — a predicate naming an undeclared kind fails
 * `dogwood validate` with code `extension`: "predicate
 * `Drupe::Action::\"Read\"::nosuchkind` does not name a declared event (no
 * event kind `nosuchkind` derived for action `Read`)". Catching it in
 * TypeScript is the point of the split epic #1646 drew: everything answerable
 * without the binary runs always and gates, and this one is answerable.
 *
 * The check is on the event *kind*, not the action, and that is not a
 * shortcut. Upstream's `.dwschema` grammar declares events against a symbolic
 * action binder — `decision event <A>::request { … }` — so the file names no
 * actions at all and cannot be asked whether one exists. The action half of
 * that upstream error comes from the Cedar action schema
 * (`--policy-schema`), which is #1659's CLI-gated leg.
 *
 * Silent when no `.dwschema` was emitted: with none supplied,
 * `ServiceSchema::defaults()` decides the kinds at the far end, and guessing
 * that a project's out-of-band schema matches upstream's default would fail
 * builds for a policy set that is fine.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { dogwoodPolicyFiles, dogwoodSchemaFiles, readEventSchema, scanPredicates } from "../../dogwood/scan";

export const dwdc010: PostSynthCheck = {
  id: "DWDC010",
  description: "A dogwood temporal predicate names an event kind the emitted .dwschema declares",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const schemas = dogwoodSchemaFiles(ctx);
    if (schemas.length === 0) return [];

    const declared = new Set<string>();
    for (const schema of schemas) {
      for (const kind of readEventSchema(schema.text).kinds) declared.add(kind);
    }
    if (declared.size === 0) return [];

    const known = [...declared].sort().join(", ");
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const policies of dogwoodPolicyFiles(ctx)) {
      const seen = new Set<string>();
      for (const ref of scanPredicates(policies.text)) {
        if (declared.has(ref.kind)) continue;
        const key = `${ref.action}::${ref.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        diagnostics.push({
          checkId: "DWDC010",
          severity: "error",
          message: `Dogwood policy set "${policies.source}" has a temporal predicate on ${key}, but the emitted event schema declares no event kind "${ref.kind}" (declared: ${known}).`,
          entity: policies.source,
          lexicon: policies.lexicon,
        });
      }
    }

    return diagnostics;
  },
};
