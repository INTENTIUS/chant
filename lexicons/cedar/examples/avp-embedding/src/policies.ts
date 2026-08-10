/**
 * The same policy set, twice: as `.cedar` text, and embedded in AVP resources.
 *
 * `chant build` writes the `.cedar` file and the JSON policy set from the
 * `Policy` declarations below — that is the artifact any Cedar evaluator reads.
 * The `avpPolicies` export beneath them is the *deployment* view: the exact
 * `Definition` property `AWS::VerifiedPermissions::Policy` takes, rendered from
 * the same declarations by the same renderer.
 *
 * The point is that nothing is written twice. Today a team deploying to AVP
 * writes its policy text as a template string inside a CloudFormation
 * declaration and finds out at deploy time whether `App::Documnt` is a real
 * entity type. Here the policy is a typed declaration, the statement is derived
 * from it, and the `.cedar` file and the AVP statement cannot disagree.
 */

import { Policy, ReadAction, WriteAction, avpPolicyDefinition } from "@intentius/chant-lexicon-cedar";

/** Which store these deploy into. In a real project, `store.ref()`. */
const POLICY_STORE_ID = "PS-EXAMPLE0000000000000";

/** Which stack and environment own these, for the description marker. */
const ownership = { stack: "authz", env: "prod" };

// ── The policies ──────────────────────────────────────────────────

/** Users read the documents they own. */
export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});

/** Writes need the owner and MFA. */
export const ownerWrite = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: WriteAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal", "context.mfa == true"],
});

/** Nothing confidential is readable without MFA, owner or not. */
export const requireMfa = new Policy({
  effect: "forbid",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ['resource.classification == "confidential"'],
  unless: ["context.mfa == true"],
});

// ── The AVP deployment view ───────────────────────────────────────

/**
 * A stand-in for the aws lexicon's generated `VerifiedPermissionsPolicy`.
 *
 * The cedar lexicon does not depend on the aws lexicon — Cedar is
 * vendor-neutral and AVP is one of several evaluators — so this example uses a
 * plain object carrying the exact prop names the generated class declares
 * (`PolicyStoreId`, `Definition`, `Name`). Swapping it for the real thing in a
 * project that installs both is a one-line change:
 *
 * ```ts
 * import { VerifiedPermissionsPolicy } from "@intentius/chant-lexicon-aws";
 *
 * export const ownerReadPolicy = new VerifiedPermissionsPolicy({
 *   PolicyStoreId: policyStore.ref(),
 *   Definition: avpPolicyDefinition("ownerRead", ownerReadProps),
 * });
 * ```
 *
 * The example cannot use the real class as it stands: the shipped cedar
 * examples are built against the cedar serializer alone, so an aws entity in
 * this tree would have no serializer to emit it.
 */
interface VerifiedPermissionsPolicyProps {
  PolicyStoreId: string;
  Definition: ReturnType<typeof avpPolicyDefinition>;
  Name?: string;
}

/**
 * The props for one `AWS::VerifiedPermissions::Policy` per declared policy.
 *
 * The props objects are repeated here rather than read back off the `Policy`
 * declarations because a policy's props are its constructor argument; a project
 * that wants the set without repeating itself calls `avpPolicySet(entities)`
 * from a build hook instead.
 */
export const avpPolicies: Record<string, VerifiedPermissionsPolicyProps> = {
  ownerRead: {
    PolicyStoreId: POLICY_STORE_ID,
    Name: "owner-read",
    Definition: avpPolicyDefinition(
      "ownerRead",
      {
        effect: "permit",
        principal: { is: "App::User" },
        action: { eq: ReadAction },
        resource: { is: "App::Document" },
        when: ["resource.owner == principal"],
      },
      { ownership, description: "Owners read their own documents." },
    ),
  },
  ownerWrite: {
    PolicyStoreId: POLICY_STORE_ID,
    Name: "owner-write",
    Definition: avpPolicyDefinition(
      "ownerWrite",
      {
        effect: "permit",
        principal: { is: "App::User" },
        action: { eq: WriteAction },
        resource: { is: "App::Document" },
        when: ["resource.owner == principal", "context.mfa == true"],
      },
      { ownership, description: "Owners write their own documents, with MFA." },
    ),
  },
  requireMfa: {
    PolicyStoreId: POLICY_STORE_ID,
    Name: "require-mfa",
    Definition: avpPolicyDefinition(
      "requireMfa",
      {
        effect: "forbid",
        principal: { is: "App::User" },
        action: { eq: ReadAction },
        resource: { is: "App::Document" },
        when: ['resource.classification == "confidential"'],
        unless: ["context.mfa == true"],
      },
      { ownership, description: "Confidential documents need MFA." },
    ),
  },
};
