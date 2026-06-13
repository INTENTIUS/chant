/**
 * GHA057: Dependency Update Executing Untrusted External Code
 *
 * Flags a dependabot `updates:` entry with
 * `insecure-external-code-execution: allow`. That setting lets a freshly-pulled
 * dependency run lifecycle scripts (e.g. npm `postinstall`) during the update
 * itself — a compromised release executes in the update job before any review.
 * Set it to `deny`, or isolate the ecosystem.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getDependabotYaml, extractDependabotUpdates } from "./yaml-helpers";

export const gha057: PostSynthCheck = {
  id: "GHA057",
  description: "Dependency update allows executing untrusted external code",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const dependabot = getDependabotYaml(output);
      if (!dependabot) continue;
      for (const update of extractDependabotUpdates(dependabot)) {
        if (update["insecure-external-code-execution"] === "allow") {
          const eco = String(update["package-ecosystem"] ?? "?");
          diagnostics.push({
            checkId: "GHA057",
            severity: "error",
            message: `Dependabot update for "${eco}" sets insecure-external-code-execution: allow, running dependency lifecycle scripts during the update. Set it to deny.`,
            entity: eco,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
