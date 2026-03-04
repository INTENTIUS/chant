/**
 * WGL020: Duplicate Job Names
 *
 * Detects multiple jobs that resolve to the same kebab-case name in
 * the serialized YAML. GitLab silently merges duplicate keys, which
 * causes unexpected behavior.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractJobs } from "./yaml-helpers";

export function checkDuplicateJobNames(yaml: string): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];

  // Count occurrences of each top-level key (raw line parsing, not extractJobs,
  // to detect actual YAML key duplication)
  const keyCounts = new Map<string, number>();
  const lines = yaml.split("\n");

  for (const line of lines) {
    const topMatch = line.match(/^(\.?[a-z][a-z0-9_.-]*):/);
    if (topMatch) {
      const name = topMatch[1];
      if (["stages", "default", "workflow", "variables", "include"].includes(name)) continue;
      keyCounts.set(name, (keyCounts.get(name) ?? 0) + 1);
    }
  }

  for (const [name, count] of keyCounts) {
    if (count > 1) {
      diagnostics.push({
        checkId: "WGL020",
        severity: "error",
        message: `Duplicate job name "${name}" appears ${count} times — GitLab will silently merge these`,
        entity: name,
        lexicon: "gitlab",
      });
    }
  }

  return diagnostics;
}

export const wgl020: PostSynthCheck = {
  id: "WGL020",
  description: "Duplicate job names — multiple jobs resolving to same name",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      diagnostics.push(...checkDuplicateJobNames(yaml));
    }
    return diagnostics;
  },
};
