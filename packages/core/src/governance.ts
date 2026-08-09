/**
 * Governance verb vocabulary .
 *
 * `resourceType` on a change-set entry is a free provider-specific string
 * ("team", "branch-protection", "protected-tag", …) chosen per cycle. That is
 * right for display but useless for reading two providers' plans as one
 * grammar. The verb is the cross-provider category a cycle reconciles;
 * provider-specific cycle names stay for display.
 *
 * SCM and cloud cycles stamp the same verbs, so a GitHub plan and an AWS plan
 * group the same way:
 *
 * - `org-unit` — the containers and their settings: GitHub org/repo settings,
 *   GitLab group/project/instance settings, cloud OUs/folders/accounts.
 * - `policy-guardrail` — rules constraining what may happen: branch
 *   protections, rulesets, push rules, MR approvals, security features,
 *   dependency hygiene, SCPs, Org Policies.
 * - `membership` — who belongs, directly or via teams: org members, team
 *   membership, group members.
 * - `identity-assignment` — non-person and delegated access: tokens, deploy
 *   keys, service credentials, SSO/IAM assignments. `membership` is people
 *   in containers; this is everything else that can act.
 * - `audit-sink` — where events and evidence flow: webhooks, integrations,
 *   CloudTrail/audit-log sinks.
 * - `secret-material` — secrets and CI variables the platform stores.
 *
 * A cycle has exactly one verb. When a cycle plausibly spans two (GitHub
 * `environments` carries both reviewer gates and secrets), stamp the verb of
 * the cycle's primary object — the thing whose create/delete the cycle owns —
 * not of fields it also happens to write.
 */

/** The cross-provider governance category a cycle reconciles. */
export type GovernanceVerb =
  | "org-unit"
  | "policy-guardrail"
  | "membership"
  | "identity-assignment"
  | "audit-sink"
  | "secret-material";

/** Every verb, for exhaustiveness checks ("does each cycle stamp one?"). */
export const GOVERNANCE_VERBS: readonly GovernanceVerb[] = [
  "org-unit",
  "policy-guardrail",
  "membership",
  "identity-assignment",
  "audit-sink",
  "secret-material",
];

export function isGovernanceVerb(v: unknown): v is GovernanceVerb {
  return typeof v === "string" && (GOVERNANCE_VERBS as readonly string[]).includes(v);
}
