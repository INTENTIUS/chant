/**
 * GHA058: Dependency Update Without a Cooldown
 *
 * Flags a dependabot `updates:` entry with no cooldown (or an all-zero one). A
 * version published seconds ago — including a compromised one — is adopted
 * immediately, with no window for the ecosystem to yank it or for anyone to
 * react. Configure a `cooldown:` so freshly-published versions wait before they
 * are proposed.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getDependabotYaml, extractDependabotUpdates } from "./yaml-helpers";

const COOLDOWN_DAY_KEYS = ["default-days", "semver-major-days", "semver-minor-days", "semver-patch-days"];

function hasEffectiveCooldown(cooldown: unknown): boolean {
  if (!cooldown || typeof cooldown !== "object") return false;
  const c = cooldown as Record<string, unknown>;
  return COOLDOWN_DAY_KEYS.some((k) => typeof c[k] === "number" && (c[k] as number) > 0);
}

export const gha058: PostSynthCheck = {
  id: "GHA058",
  description: "Dependency update has no cooldown window",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const dependabot = getDependabotYaml(output);
      if (!dependabot) continue;
      for (const update of extractDependabotUpdates(dependabot)) {
        if (!hasEffectiveCooldown(update.cooldown)) {
          const eco = String(update["package-ecosystem"] ?? "?");
          diagnostics.push({
            checkId: "GHA058",
            severity: "warning",
            message: `Dependabot update for "${eco}" has no cooldown — a version published moments ago is adopted immediately. Add a cooldown window so fresh (possibly compromised) releases wait before they are proposed.`,
            entity: eco,
            lexicon: "github",
          });
        }
      }
    }

    return diagnostics;
  },
};
