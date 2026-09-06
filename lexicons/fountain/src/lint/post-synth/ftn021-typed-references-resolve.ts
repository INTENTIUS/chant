import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant";
import { propsOf } from "../../entity-props";

/**
 * FTN021: a typed reference must resolve to something the build declares.
 *
 * `Teammate.agent` and `Schedule.teammate` serialize to a name, and fountain
 * resolves names at apply. A name with a typo therefore fails in the middle of
 * a reconcile, after the resources ahead of it in the manifest have already
 * been written. This moves that failure to build time.
 *
 * A reference may be the declaration itself (the ordinary typed form, always
 * resolvable) or a string. A string is checked against both the declared
 * `name` and the export name, because either is what an author reading the
 * emitted manifest would copy. A string that matches neither is the error: a
 * teammate whose agent chant does not declare is a teammate chant cannot
 * reconcile, however well the name reads.
 */

interface RefRule {
  entityType: string;
  prop: string;
  targetType: string;
  targetKind: string;
}

const REFS: RefRule[] = [
  {
    entityType: "Fountain::V1::Teammate",
    prop: "agent",
    targetType: "Fountain::V1::Agent",
    targetKind: "Agent",
  },
  {
    entityType: "Fountain::V1::Schedule",
    prop: "teammate",
    targetType: "Fountain::V1::Teammate",
    targetKind: "Teammate",
  },
];

/** Every name a declared entity answers to: its fountain name and its export name. */
function namesOf(entities: Map<string, Declarable>, targetType: string): Set<string> {
  const names = new Set<string>();
  for (const [exportName, entity] of entities) {
    if (entity.entityType !== targetType) continue;
    names.add(exportName);
    const declared = propsOf(entity).name;
    if (typeof declared === "string" && declared.length > 0) names.add(declared);
  }
  return names;
}

export const typedReferencesResolveCheck: PostSynthCheck = {
  id: "FTN021",
  description: "A Teammate's agent and a Schedule's teammate must resolve within the build",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const rule of REFS) {
      const declared = namesOf(ctx.entities, rule.targetType);

      for (const [name, entity] of ctx.entities) {
        if (entity.entityType !== rule.entityType) continue;
        const ref = propsOf(entity)[rule.prop];

        if (typeof ref !== "string") continue; // the declaration itself, or absent (a required-prop error elsewhere)
        if (declared.has(ref)) continue;

        diagnostics.push({
          checkId: "FTN021",
          severity: "error",
          message:
            `${rule.entityType.split("::").pop()} "${name}" names ${rule.targetKind} "${ref}", ` +
            `which this build does not declare — apply would fail partway through` +
            (declared.size > 0 ? ` (declared: ${[...declared].sort().join(", ")})` : ""),
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
