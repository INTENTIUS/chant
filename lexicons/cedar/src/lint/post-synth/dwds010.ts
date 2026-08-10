/**
 * DWDS010: an emitted event schema with no pinned field widens every predicate
 *
 * The #1657 verification is specific about this one. `ServiceSchema::defaults()`
 * — what runs when nobody passes `--event-schema` — uses
 * `configuration/event-schemas/pinned.dwschema`, which carries
 * `pin callerPrincipal: principalType(A) = principal` on every kind. Every
 * temporal predicate is therefore correlated to the deciding request's
 * principal, and events from other principals are invisible.
 *
 * Supplying any event schema opts out of that default wholesale. So a schema
 * emitted without a pin does not merely "not add" a correlation: it removes
 * one the policy author very likely assumed, and every `formerly` in the set
 * starts matching other principals' events. That is a legitimate design —
 * cross-principal correlation is the reason to write your own schema — but it
 * is a decision, and a decision nobody can see in a diff is one nobody made.
 *
 * Report-only: chant does not know which the author wanted, only that it
 * should be said out loud. `defaultEventSchema({ pinCallerPrincipal: false })`
 * also stamps the reasoning into the emitted file.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { dogwoodSchemaFiles, readEventSchema } from "../../dogwood/scan";

export const dwds010: PostSynthCheck = {
  id: "DWDS010",
  description: "An emitted dogwood event schema pins its temporal predicates to a request-side value",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const schema of dogwoodSchemaFiles(ctx)) {
      const facts = readEventSchema(schema.text);
      if (facts.kinds.length === 0 || facts.hasPin) continue;
      diagnostics.push({
        checkId: "DWDS010",
        severity: "warning",
        message: `Dogwood event schema "${schema.source}" declares no pinned field, so temporal predicates correlate across every principal — wider than upstream's default, which pins callerPrincipal to the deciding request's principal. Add a pinned field, or record why cross-principal correlation is wanted.`,
        entity: schema.source,
        lexicon: schema.lexicon,
      });
    }

    return diagnostics;
  },
};
