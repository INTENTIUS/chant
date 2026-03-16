/**
 * WGL025: Missing Cache Key
 *
 * Warns about `cache:` without `key:`. Without an explicit key, GitLab
 * uses `default` as the key, which causes cache collisions between
 * unrelated jobs sharing the same runner.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isPropertyDeclarable } from "@intentius/chant/declarable";

export const wgl025: PostSynthCheck = {
  id: "WGL025",
  description: "Missing cache key — cache without key causes collisions",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of ctx.entities) {
      if (isPropertyDeclarable(entity)) continue;
      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType !== "GitLab::CI::Job") continue;

      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (!props?.cache) continue;

      // Cache can be a single object or an array
      const caches = Array.isArray(props.cache) ? props.cache : [props.cache];

      for (const cache of caches) {
        const cacheObj = cache as Record<string, unknown>;
        const cacheProps = (cacheObj.props as Record<string, unknown> | undefined) ?? cacheObj;

        if (!cacheProps.key) {
          diagnostics.push({
            checkId: "WGL025",
            severity: "warning",
            message: `Job "${entityName}" has cache without a key — this causes cache collisions between jobs`,
            entity: entityName,
            lexicon: "gitlab",
          });
          break; // One diagnostic per job is enough
        }
      }
    }

    return diagnostics;
  },
};
