/**
 * The render lexicon's chant audit catalog — metadata for the REN post-synth
 * checks, contributed via `renderPlugin.auditCatalog()`.
 *
 * All entries carry `yamlBased: false`: each check reads the chant model
 * (`ctx.entities`) rather than the emitted plan, because what they need — the
 * runtime, the plan tier, whether a source was named — lives in the typed
 * graph. So they fire on `chant build` and cannot fire on an audit of a
 * standalone Render config.
 */

import type { RuleMeta } from "@intentius/chant/audit/catalog";
import { renderAuditLineage } from "./audit-lineage";
import { applyLineage } from "@intentius/chant/audit/catalog";

/** Entity-based rule: everything render ships. */
function rule(
  id: string,
  tier: RuleMeta["tier"],
  category: RuleMeta["category"],
  title: string,
  remediation: string,
): RuleMeta {
  return { id, tier, fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const renderAuditCatalog: Record<string, RuleMeta> = {
  REN010: rule(
    "REN010",
    "merge-worthy",
    "correctness",
    "Native-runtime service has no build/start command",
    "Set `envSpecificDetails: new NativeEnvironmentDetails({ buildCommand, startCommand })` on the service.",
  ),
  REN011: rule(
    "REN011",
    "merge-worthy",
    "correctness",
    "Service has no source (repo or image)",
    "Set `repo` for a git-backed service, or `image: new Image({ imagePath })` for an image-backed one.",
  ),
  REN012: rule(
    "REN012",
    "merge-worthy",
    "correctness",
    "Free-plan service configured to scale or mount a disk",
    "Move the service to a paid instance type, or drop numInstances/autoscaling/disk.",
  ),
};

// Prior art credits live beside the rules in ./audit-lineage.ts (see core audit/prior-art.ts).
applyLineage(renderAuditCatalog, renderAuditLineage);
