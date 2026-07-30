import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN017: resource names must be unique per kind.
 *
 * fountainApply reconciles by name; two entities of the same kind
 * resolving to the same fountain name would fight over one live
 * resource — the second apply step silently becomes an update of the
 * first one's creation.
 */
export const uniqueResourceNamesCheck: PostSynthCheck = {
  id: "FTN017",
  description: "Two declarations of the same kind must not resolve to the same fountain name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const seen = new Map<string, string>();

    for (const [entityName, entity] of ctx.entities) {
      if (!entity.entityType.startsWith("Fountain::V1::")) continue;
      const props = entity as unknown as { name?: unknown };
      const resourceName = typeof props.name === "string" ? props.name : entityName;
      const key = `${entity.entityType}/${resourceName}`;
      const first = seen.get(key);
      if (first) {
        diagnostics.push({
          checkId: "FTN017",
          severity: "error",
          message:
            `"${entityName}" and "${first}" both resolve to ${key} — apply would ` +
            `reconcile them onto one live resource`,
          entity: entityName,
          lexicon: "fountain",
        });
      } else {
        seen.set(key, entityName);
      }
    }

    return diagnostics;
  },
};
