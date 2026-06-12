/**
 * WGL032: Include/Component Source Resembling a Well-Known Project
 *
 * Flags an `include:project` path or `component:` source that is a near-miss
 * (edit distance 1–2) of a well-known GitLab CI source but not an exact match —
 * a likely typo or an impersonation of the trusted project. Advisory; backed by
 * a vendored reference list.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractIncludes } from "./yaml-helpers";
import { KNOWN_INCLUDE_SOURCES, editDistance } from "../rules/data/known-include-sources";

const KNOWN = new Set(KNOWN_INCLUDE_SOURCES);

/** Reduce a component address (`host/group/name@ver`) or project path to its group/name path. */
function sourcePath(value: string, kind: string): string {
  let v = value;
  if (kind === "component") {
    const at = v.lastIndexOf("@");
    if (at !== -1) v = v.slice(0, at);
    const slash = v.indexOf("/");
    if (slash !== -1 && v.slice(0, slash).includes(".")) v = v.slice(slash + 1); // drop host
  }
  return v;
}

export function nearestKnownSource(path: string): string | undefined {
  if (KNOWN.has(path)) return undefined;
  let best: string | undefined;
  let bestDist = 3;
  for (const known of KNOWN) {
    const d = editDistance(path, known, 2);
    if (d >= 1 && d <= 2 && d < bestDist) {
      best = known;
      bestDist = d;
    }
  }
  return best;
}

export const wgl032: PostSynthCheck = {
  id: "WGL032",
  description: "Include/component source resembles a well-known project (possible impersonation)",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      for (const entry of extractIncludes(yaml)) {
        if (entry.kind !== "project" && entry.kind !== "component") continue;
        const path = sourcePath(entry.value, entry.kind);
        const lookAlike = nearestKnownSource(path);
        if (!lookAlike) continue;
        diagnostics.push({
          checkId: "WGL032",
          severity: "warning",
          message: `Include source "${path}" closely resembles the well-known "${lookAlike}". Confirm the source is who you intend — this may be a typo or impersonation.`,
          entity: entry.value,
          lexicon: "gitlab",
        });
      }
    }

    return diagnostics;
  },
};
