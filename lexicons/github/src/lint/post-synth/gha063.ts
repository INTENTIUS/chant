/**
 * GHA063: Dependency Setup Without Caching
 *
 * Flags a `actions/setup-{node,python,java,ruby,dotnet}` step that leaves its
 * built-in `cache:` option unset, with no adjacent `actions/cache` step to
 * cover the gap. Every run re-downloads the same dependencies from the
 * registry from a cold cache — pure wasted time and bandwidth, not a
 * correctness or security issue (efficiency, #444).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, jobEntries, parseActionUses } from "./yaml-helpers";

/** Setup actions whose `with.cache` option enables built-in dependency caching. */
const CACHEABLE_SETUP_ACTIONS = new Set(["actions/setup-node", "actions/setup-python", "actions/setup-java", "actions/setup-ruby", "actions/setup-dotnet"]);

function cacheEnabled(withBlock: unknown): boolean {
  if (!withBlock || typeof withBlock !== "object") return false;
  const cache = (withBlock as Record<string, unknown>).cache;
  if (typeof cache === "boolean") return cache;
  if (typeof cache === "string") return cache.trim().length > 0 && cache.trim() !== "false";
  return false;
}

export const gha063: PostSynthCheck = {
  id: "GHA063",
  description: "Dependency setup action without caching enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);

      for (const [jobName, jobObj] of jobEntries(yaml)) {
        const steps = Array.isArray(jobObj.steps) ? (jobObj.steps as Array<Record<string, unknown>>) : [];
        const hasGenericCacheStep = steps.some((s) => parseActionUses(String(s.uses ?? ""))?.slug === "actions/cache");
        if (hasGenericCacheStep) continue;

        for (const step of steps) {
          const uses = typeof step.uses === "string" ? step.uses : undefined;
          if (!uses) continue;
          const parsed = parseActionUses(uses);
          if (!parsed || !CACHEABLE_SETUP_ACTIONS.has(parsed.slug)) continue;
          if (cacheEnabled(step.with)) continue;

          diagnostics.push({
            checkId: "GHA063",
            severity: "info",
            message: `Job "${jobName}" uses ${parsed.slug} without enabling its \`cache:\` option, and no separate actions/cache step covers it — dependencies are re-fetched from a cold cache on every run. Set \`with.cache\` (e.g. \`cache: npm\`) or add an actions/cache step.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
