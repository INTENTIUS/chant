/**
 * GHA031: Action Reference Resembling a Well-Known Action
 *
 * Flags a `uses:` slug that is a near-miss (edit distance 1–2) of a popular
 * action but not an exact match — a likely typo or a deliberate impersonation
 * of the well-known action under different ownership. Advisory only; backed by
 * a vendored reference list.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractActionRefs, parseActionUses } from "./yaml-helpers";
import { KNOWN_ACTION_SLUGS } from "../rules/data/known-action-slugs";

const KNOWN = new Set(KNOWN_ACTION_SLUGS);

/** Levenshtein edit distance, capped: returns early once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(val);
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/** Find the nearest known slug within edit distance 1–2 of `slug`, if any. */
export function nearestLookAlike(slug: string): string | undefined {
  if (KNOWN.has(slug)) return undefined; // exact match is legitimate
  let best: string | undefined;
  let bestDist = 3;
  for (const known of KNOWN) {
    const d = editDistance(slug, known, 2);
    if (d >= 1 && d <= 2 && d < bestDist) {
      best = known;
      bestDist = d;
    }
  }
  return best;
}

export const gha031: PostSynthCheck = {
  id: "GHA031",
  description: "Action reference resembles a well-known action (possible impersonation)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const { job, ref } of extractActionRefs(yaml)) {
        const parsed = parseActionUses(ref);
        if (!parsed) continue;
        const lookAlike = nearestLookAlike(parsed.slug);
        if (!lookAlike) continue;
        diagnostics.push({
          checkId: "GHA031",
          severity: "warning",
          message: `Job "${job}" uses "${parsed.slug}", which closely resembles the well-known action "${lookAlike}". Confirm the owner is who you intend — this may be a typo or impersonation.`,
          entity: job,
          lexicon: "github",
        });
      }
    }

    return diagnostics;
  },
};
