/**
 * The k3s lexicon's chant audit catalog — metadata for its post-synth
 * checks, contributed via k3sPlugin.auditCatalog() (#687, #1346). Every
 * post-synth check has an entry, or the check contributes nothing to
 * `chant audit`, silently.
 *
 * All five checks read the chant model (`ctx.entities`) rather than the
 * emitted YAML — an emitted config.yaml carries no marker naming its own
 * role — so every entry is constructed directly with `yamlBased: false`.
 */
import type { RuleMeta } from "@intentius/chant/audit/catalog";

function entityRule(
  id: string,
  category: RuleMeta["category"],
  title: string,
  remediation: string,
): RuleMeta {
  return { id, tier: "merge-worthy", fixKind: "guidance", category, title, remediation, yamlBased: false };
}

export const k3sAuditCatalog: Record<string, RuleMeta> = {
  K3S101: entityRule(
    "K3S101",
    "security",
    "Literal join token in a k3s config",
    "Remove the `token` value; point `token-file` at a path on the host instead.",
  ),
  K3S102: entityRule(
    "K3S102",
    "security",
    "Literal registry credential in registries.yaml",
    "Remove the credential from the declaration; configure registry auth on the host.",
  ),
  K3S103: entityRule(
    "K3S103",
    "correctness",
    "Agent config with no server to join",
    "Set `server: https://<server-host>:6443` on the agent declaration.",
  ),
  K3S104: entityRule(
    "K3S104",
    "security",
    "Kubeconfig written wider than 0644",
    "Drop `write-kubeconfig-mode`, or keep it at 0600/0644.",
  ),
  K3S105: entityRule(
    "K3S105",
    "security",
    "Registry TLS verification disabled",
    "Remove `insecure_skip_verify`; pin the registry CA via `ca_file`.",
  ),
};
