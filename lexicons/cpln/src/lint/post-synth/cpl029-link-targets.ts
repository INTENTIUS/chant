import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf, readString } from "../../entity-props";
import type { Declarable } from "@intentius/chant/declarable";
import { KINDS, kindByTypeName } from "../../kinds";
import { GVC, WORKLOAD, entitiesOfType, parseLink } from "./helpers";

/**
 * Every string anywhere in a value, so links are found wherever they were
 * written. Depth-bounded — a spec is deep but finite, and a cycle would not be.
 */
function* strings(value: unknown, depth = 0): Generator<string> {
  if (depth > 12) return;
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* strings(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(propsOf(value))) yield* strings(nested, depth + 1);
  }
}

/**
 * A workload's identity must live in the workload's own GVC.
 *
 * Identities cannot be shared across GVCs — the documented remedy is to
 * recreate the identity with the same spec in each GVC that needs it. A
 * cross-GVC `identityLink` is therefore never right, however reasonable it
 * reads.
 */
function identityGvcCheck(entities: Map<string, Declarable>): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [name, entity] of entitiesOfType(entities, WORKLOAD)) {
    const workloadGvc = readString(entity, "gvc");
    const identityLink = readString(entity, "spec", "identityLink");
    if (!workloadGvc || !identityLink) continue;

    const link = parseLink(identityLink);
    if (!link || link.kind !== "identity" || !link.gvc) continue;
    if (link.gvc === workloadGvc) continue;

    diagnostics.push({
      checkId: "CPL029",
      severity: "error",
      message:
        `Workload "${name}" is in GVC "${workloadGvc}" but its identityLink names GVC "${link.gvc}". ` +
        `Identities cannot be shared across GVCs — declare an identity with the same spec in ` +
        `"${workloadGvc}".`,
      entity: name,
      lexicon: "cpln",
    });
  }

  return diagnostics;
}

export const linkTargetsCheck: PostSynthCheck = {
  id: "CPL029",
  description: "Control Plane links must resolve to a declared resource of the right kind and GVC",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // Declared resources by kind → name → its GVC (undefined for org-scoped).
    const declared = new Map<string, Map<string, string | undefined>>();
    const declaredKinds = new Set<string>();

    for (const [entityName, entity] of ctx.entities) {
      const kind = kindByTypeName(entity.entityType);
      if (!kind) continue;
      declaredKinds.add(kind.kind);
      const byName = declared.get(kind.kind) ?? new Map<string, string | undefined>();
      byName.set(readString(entity, "name") ?? entityName, readString(entity, "gvc"));
      declared.set(kind.kind, byName);
    }

    const knownKinds = new Set(KINDS.map((k) => k.kind));

    for (const [entityName, entity] of ctx.entities) {
      const kind = kindByTypeName(entity.entityType);
      if (!kind) continue;
      const ownGvc = readString(entity, "gvc");

      for (const value of strings(propsOf(entity))) {
        const link = parseLink(value);
        if (!link || !knownKinds.has(link.kind)) continue;

        // Only assert against kinds this stack actually declares. Referencing a
        // secret managed by another team is ordinary, not a defect.
        if (!declaredKinds.has(link.kind)) continue;

        const byName = declared.get(link.kind)!;
        if (!byName.has(link.name)) {
          diagnostics.push({
            checkId: "CPL029",
            severity: "warning",
            message:
              `${kind.kind} "${entityName}" links to "${value}", but no ${link.kind} named "${link.name}" ` +
              `is declared in this stack. Control Plane accepts a dangling link without error.`,
            entity: entityName,
            lexicon: "cpln",
          });
          continue;
        }

        const targetGvc = byName.get(link.name);
        if (link.gvc && targetGvc && link.gvc !== targetGvc) {
          diagnostics.push({
            checkId: "CPL029",
            severity: "error",
            message:
              `${kind.kind} "${entityName}" links to "${value}", but ${link.kind} "${link.name}" is ` +
              `declared in GVC "${targetGvc}".`,
            entity: entityName,
            lexicon: "cpln",
          });
        }
      }
    }

    // A GVC-scoped resource whose GVC is declared here must name one that exists.
    if (declaredKinds.has("gvc")) {
      const gvcNames = new Set<string>();
      for (const [entityName, entity] of entitiesOfType(ctx.entities, GVC)) {
        gvcNames.add(readString(entity, "name") ?? entityName);
      }

      for (const [entityName, entity] of ctx.entities) {
        const kind = kindByTypeName(entity.entityType);
        if (!kind?.gvcScoped) continue;
        const gvc = readString(entity, "gvc");
        if (!gvc || gvcNames.has(gvc)) continue;

        diagnostics.push({
          checkId: "CPL029",
          severity: "warning",
          message:
            `${kind.kind} "${entityName}" is placed in GVC "${gvc}", which this stack does not declare. ` +
            `If the GVC is managed elsewhere this is fine; if it is a typo, the apply fails with a ` +
            `not-found on the parent.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }
    }

    diagnostics.push(...identityGvcCheck(ctx.entities));

    return diagnostics;
  },
};
