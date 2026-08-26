/**
 * GHA067: Unconditional Heavy Step With No Path Filter
 *
 * Flags a `docker build`/`docker buildx build` step that has no `if:` guard,
 * in a workflow that triggers on `push`/`pull_request` with no `paths:` or
 * `paths-ignore:` filter. A docs-only or unrelated change still pays for a
 * full image build because nothing scopes the trigger or guards the step.
 * Efficiency (#444), not a correctness or security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, parseDoc, jobEntries } from "./yaml-helpers";

const DOCKER_BUILD_RE = /\bdocker(\s+buildx)?\s+build\b/i;

function triggerObject(on: unknown, key: string): Record<string, unknown> | undefined {
  if (!on || typeof on !== "object" || Array.isArray(on)) return undefined;
  const trig = (on as Record<string, unknown>)[key];
  return trig && typeof trig === "object" && !Array.isArray(trig) ? (trig as Record<string, unknown>) : undefined;
}

function hasPushOrPRTrigger(on: unknown): boolean {
  if (typeof on === "string") return on === "push" || on === "pull_request";
  if (Array.isArray(on)) return on.includes("push") || on.includes("pull_request");
  if (on && typeof on === "object") {
    const keys = Object.keys(on as Record<string, unknown>);
    return keys.includes("push") || keys.includes("pull_request");
  }
  return false;
}

function hasPathFilter(on: unknown): boolean {
  for (const key of ["push", "pull_request"]) {
    const trig = triggerObject(on, key);
    if (!trig) continue;
    if (Array.isArray(trig.paths) && trig.paths.length > 0) return true;
    if (Array.isArray(trig["paths-ignore"]) && trig["paths-ignore"].length > 0) return true;
  }
  return false;
}

export const gha067: PostSynthCheck = {
  id: "GHA067",
  description: "Unconditional docker build with no path filter or guard",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const doc = parseDoc(yaml);
      if (!doc) continue;
      if (!hasPushOrPRTrigger(doc.on)) continue;
      if (hasPathFilter(doc.on)) continue;

      for (const [jobName, jobObj] of jobEntries(yaml)) {
        const steps = Array.isArray(jobObj.steps) ? (jobObj.steps as Array<Record<string, unknown>>) : [];
        for (const step of steps) {
          const run = typeof step.run === "string" ? step.run : undefined;
          if (!run || !DOCKER_BUILD_RE.test(run)) continue;
          if (step.if !== undefined) continue; // already guarded

          diagnostics.push({
            checkId: "GHA067",
            severity: "info",
            message: `Job "${jobName}" runs a Docker build on every push/pull_request with no \`paths:\`/\`paths-ignore:\` filter and no \`if:\` guard — unrelated changes (docs, etc.) still pay for a full image build. Scope the trigger's paths or add a guard.`,
            entity: jobName,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
