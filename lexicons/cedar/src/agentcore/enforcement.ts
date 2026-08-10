/**
 * `EnforcementMode` — the dial that makes a policy rollout observable before it
 * is binding (#1660).
 *
 * `AWS::BedrockAgentCore::Policy` carries an optional `EnforcementMode` with
 * exactly two values, and the CloudFormation schema says what they mean:
 *
 * > Whether the policy contributes to the enforce decision returned to Gateway.
 * > LOG_ONLY policies are still evaluated but their decisions are observed
 * > only, allowing customers to validate a policy against real traffic before
 * > promoting it.
 *
 * That is observe-before-enforce, in the substrate, per policy — the same shape
 * chant already has at the ops layer, and the reason epic #1646 picked
 * AgentCore as the deployment target for the temporal dialect rather than
 * inventing a staging mechanism. A temporal policy is the case that needs it
 * most: `formerly within 24h …` cannot be reasoned about from the source alone,
 * because whether it fires depends on traffic nobody has replayed yet.
 *
 * ### The two names, and why chant does not reuse AWS's
 *
 * The wire values are `LOG_ONLY` and `ACTIVE`. `ACTIVE` is a poor name for
 * "enforcing" — it reads as "not disabled", and `LOG_ONLY` is active too; it is
 * evaluated on every request. So the authoring vocabulary here is
 * `"log-only"` / `"enforce"`, and {@link enforcementMode} is the one place the
 * translation happens. The wire values are exported as well, for a caller that
 * has one in hand from a live read.
 *
 * ### The showcase seam (loomster#171)
 *
 * loomster#171 wants a staged policy rollout it can demonstrate end to end:
 * ship the policy log-only, watch what it would have denied, promote it. This
 * module is that seam. The whole rollout is one argument —
 * `agentCoreStagedPolicy(name, policy, stage)` — so the promotion is a
 * one-token diff a reviewer can see, rather than a hand-edited string in a
 * CloudFormation resource. Anything more elaborate (which environments are
 * promoted, who decides) belongs to the caller's own config; this module's job
 * is to make the two states nameable and the transition legible.
 */

/**
 * The wire values `EnforcementMode` takes, keyed by the stage they implement.
 *
 * A typed constant pair rather than a bare union so a caller reads
 * `AGENTCORE_ENFORCEMENT.logOnly` at the call site and cannot typo the string.
 */
export const AGENTCORE_ENFORCEMENT = {
  /** Evaluated on every request; its decision is observed, never returned. */
  logOnly: "LOG_ONLY",
  /** Contributes to the decision Gateway returns. AWS's own default. */
  enforce: "ACTIVE",
} as const;

/** The `EnforcementMode` property value, as CloudFormation spells it. */
export type AgentCoreEnforcementMode = (typeof AGENTCORE_ENFORCEMENT)[keyof typeof AGENTCORE_ENFORCEMENT];

/** The stage of a rollout, in the vocabulary the seam is authored in. */
export type AgentCoreStage = "log-only" | "enforce";

/**
 * The `EnforcementMode` a stage deploys as.
 *
 * Omitting `EnforcementMode` entirely is legal and means `ACTIVE` — AWS's
 * schema declares that default. This helper never returns `undefined`, so a
 * policy that went through it says which stage it is in on the face of the
 * template, and a diff that promotes one shows the change.
 */
export function enforcementMode(stage: AgentCoreStage): AgentCoreEnforcementMode {
  return stage === "log-only" ? AGENTCORE_ENFORCEMENT.logOnly : AGENTCORE_ENFORCEMENT.enforce;
}

/** The stage a wire value came from — the inverse of {@link enforcementMode}. */
export function enforcementStage(mode: AgentCoreEnforcementMode | undefined): AgentCoreStage {
  return mode === AGENTCORE_ENFORCEMENT.logOnly ? "log-only" : "enforce";
}

/** True when the policy's decision reaches Gateway rather than only the log. */
export function isEnforcing(mode: AgentCoreEnforcementMode | undefined): boolean {
  return enforcementStage(mode) === "enforce";
}

/**
 * One line of prose for a stage, for a description or a plan summary.
 *
 * Kept here rather than at the call sites so every surface that explains a
 * staged policy explains it the same way.
 */
export function describeStage(stage: AgentCoreStage): string {
  return stage === "log-only"
    ? "Evaluated against real traffic; decisions are logged and do not affect the response."
    : "Enforcing: this policy's decision reaches the gateway.";
}
