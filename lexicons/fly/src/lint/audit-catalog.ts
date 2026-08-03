/**
 * The fly lexicon's chant audit catalog — metadata for the FLY post-synth
 * checks, contributed via `flyPlugin.auditCatalog()` (#687).
 *
 * Both entries carry `yamlBased: false`: each check reads the chant model
 * (`ctx.entities`) rather than the emitted manifest, because what they need —
 * whether a mount's volume is declared in the same stack — lives in the typed
 * graph and is gone by the time `fly.toml` exists. So they fire on
 * `chant build` and cannot fire on an audit of standalone Fly config.
 * `auditRule()` hardcodes `yamlBased: true`, so these are constructed directly
 * (the same reasoning as fountain's catalog).
 *
 * Without this the two checks reached `chant audit` with no title, tier, fix
 * kind, or category at all — `resolveAuditCatalog` contributes nothing for a
 * lexicon that omits the method, silently (#1346).
 */

import type { RuleMeta } from "@intentius/chant/audit/catalog";

/** Entity-based rule: everything fly ships. */
function rule(
  id: string,
  tier: RuleMeta["tier"],
  category: RuleMeta["category"],
  title: string,
  remediation: string,
): RuleMeta {
  return { id, tier, fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const flyAuditCatalog: Record<string, RuleMeta> = {
  FLY010: rule(
    "FLY010",
    "merge-worthy",
    "correctness",
    "Machine config has no image",
    "Set `config.image` on the Machine — a Machine cannot boot without one.",
  ),
  FLY011: rule(
    "FLY011",
    "merge-worthy",
    "correctness",
    "Machine mount references an undeclared volume",
    "Declare the Volume in the same stack, or point the mount at one that is.",
  ),
};
