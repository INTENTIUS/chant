/**
 * The fountain lexicon's chant audit catalog — metadata for the FTN rules,
 * contributed via `fountainPlugin.auditCatalog()` (#687).
 *
 * Every entry carries `yamlBased: false`, which is not an oversight: all of
 * fountain's checks read the chant model (`ctx.entities`), not the emitted
 * manifests (`ctx.outputs`), because the facts they need — which Environment
 * an Agent references, which keys a Vault shadows — live in the typed graph
 * and are flattened by the time YAML exists. So they fire on `chant build`
 * and cannot fire on an audit of standalone fountain YAML. `auditRule()`
 * hardcodes `yamlBased: true`, so these are constructed directly.
 */

import type { Authority, RuleMeta } from "@intentius/chant/audit/catalog";

const FOUNTAIN_PRIMITIVES: Authority = {
  name: "fountain — Environment, Vault, and Agent primitives",
  url: "https://github.com/BinaryBourbon/fountain/blob/main/docs/primitives.md",
};

const OWASP_LLM_INJECTION: Authority = {
  name: "OWASP Top 10 for LLM Applications — LLM01: Prompt Injection",
  url: "https://owasp.org/www-project-top-10-for-large-language-model-applications/",
};

/** Entity-based rule: everything fountain ships. */
function rule(
  id: string,
  tier: RuleMeta["tier"],
  category: RuleMeta["category"],
  title: string,
  remediation: string,
  authority?: Authority[],
): RuleMeta {
  return { id, tier, fixKind: "guidance", category, title, remediation, authority, yamlBased: false };
}

export const fountainAuditCatalog: Record<string, RuleMeta> = {
  FTN001: rule(
    "FTN001",
    "merge-worthy",
    "security",
    "Literal credential in a fountain declaration",
    "Use a ${VAR} substitution reference or an environment secret; never a literal in source.",
    [OWASP_LLM_INJECTION],
  ),
  FTN010: rule(
    "FTN010",
    "merge-worthy",
    "security",
    "Environment does not set networking_type explicitly",
    "Set networking_type — an open sandbox by silence is not a reviewed decision.",
    [FOUNTAIN_PRIMITIVES],
  ),
  FTN011: rule(
    "FTN011",
    "merge-worthy",
    "security",
    "Environment uses networking_type: unrestricted",
    "Prefer limited with an allowed_hosts allowlist; an empty list denies all egress.",
    [FOUNTAIN_PRIMITIVES],
  ),
  FTN012: rule(
    "FTN012",
    "merge-worthy",
    "security",
    "Cloud-credential-shaped key or value in Environment env_vars",
    "env_vars is plaintext config — move credentials to a secret, or serve the capability outside the sandbox.",
    [OWASP_LLM_INJECTION],
  ),
  FTN013: rule(
    "FTN013",
    "report-only",
    "correctness",
    "Agent ${VAR} reference does not resolve against its environment",
    "Declare the key on the environment, or confirm a vault supplies it at conversation create.",
  ),
  FTN014: rule(
    "FTN014",
    "report-only",
    "correctness",
    "Vault key shadows a declared Environment key",
    "Vault values win on key collision silently — rename the key or confirm the override is intended.",
  ),
  FTN015: rule(
    "FTN015",
    "merge-worthy",
    "security",
    "Secret-shaped MCP env key is a literal, not a ${VAR} reference",
    "Reference the value with ${VAR} so it resolves at spawn instead of living in source.",
    [OWASP_LLM_INJECTION],
  ),
  FTN016: rule(
    "FTN016",
    "merge-worthy",
    "correctness",
    "Agent runtime or model is not a valid value",
    "Use a known runtime and a canonical provider/model_id.",
  ),
  FTN017: rule(
    "FTN017",
    "merge-worthy",
    "correctness",
    "Two declarations of one kind resolve to the same fountain name",
    "fountain reconciles by name — rename one, or the second silently overwrites the first.",
  ),
};
