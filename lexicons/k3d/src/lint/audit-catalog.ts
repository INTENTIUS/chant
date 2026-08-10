/**
 * The k3d lexicon's chant audit catalog — metadata for its post-synth
 * checks, contributed via k3dPlugin.auditCatalog() (#687, #1346). Every
 * post-synth check has an entry, or the check contributes nothing to
 * `chant audit`, silently.
 */
import { auditRule, type RuleMeta } from "@intentius/chant/audit/catalog";

export const k3dAuditCatalog: Record<string, RuleMeta> = {
  K3D101: auditRule(
    "K3D101",
    "merge-worthy",
    "guidance",
    "nodeFilter matches no node",
    'Use a real k3d selector: "all", "loadbalancer", or "server"/"agent" with ":<index>" or ":*".',
    { category: "correctness" },
  ),
  K3D102: auditRule(
    "K3D102",
    "merge-worthy",
    "guidance",
    "Registry proxy password in the emitted cluster config",
    "Remove the credential from the declaration; connect the registry via registries.use or configure the proxy outside chant.",
    { category: "security" },
  ),
};
