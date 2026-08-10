---
skill: chant-cedar-avp-embedding
description: Embed a typed cedar-lexicon policy into an AWS Verified Permissions policy resource instead of a hand-written string
user-invocable: true
---

# Cedar Policies Inside Verified Permissions

## The seam

Amazon Verified Permissions is one deployment vehicle for Cedar, and chant
already ships it: `AWS::VerifiedPermissions::Policy` in the aws lexicon carries
its policy text in a `definition.static.statement` field typed `CedarPolicy` —
which is to say, `string`.

That string is the seam. Everything upstream of it — the schema, the entity
types, the actions, the scope constraints — is what the cedar lexicon owns.
Everything downstream — the policy store, the CloudFormation `ApplyOp`, the IAM
around it — is the aws lexicon's, and already works.

```
cedar lexicon                       aws lexicon
schema → Policy → .cedar text  →   VerifiedPermissionsPolicy.definition.static.statement
```

The walk-away test holds on both sides. The emitted `.cedar` file is read by any
evaluator with no AWS involved; the AVP resource deploys through the same
CloudFormation path every other AWS resource does.

## The typed handoff

`avpPolicyDefinition(name, props)` returns exactly the `Definition` property
`AWS::VerifiedPermissions::Policy` takes, rendered by the same renderer that
writes the `.cedar` file — so the deployed policy and the reviewed file cannot
disagree.

```typescript
import { Policy, ReadAction, avpPolicyDefinition } from "@intentius/chant-lexicon-cedar";
import { VerifiedPermissionsPolicy } from "@intentius/chant-lexicon-aws";

const ownerReadProps = {
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
} as const;

/** The evaluator-agnostic artifact: this is what lands in the `.cedar` file. */
export const ownerRead = new Policy(ownerReadProps);

/** The AVP deployment view of the same policy. */
export const ownerReadAvp = new VerifiedPermissionsPolicy({
  PolicyStoreId: policyStore.ref(),
  Definition: avpPolicyDefinition("ownerRead", ownerReadProps, {
    ownership: { stack: "authz", env: "prod" },
    description: "Owners read their own documents.",
  }),
});
```

Beside it: `avpStatement()` for the bare string, `avpStatementJSON()` for
evaluators that take the JSON policy format, and `avpPolicySet(entities)` to
render a whole build's policies at once, keyed by chant entity name.

**The cedar lexicon does not depend on the aws lexicon.** The seam is the data
shape, which is stable CloudFormation. `examples/avp-embedding/` shows the
pairing with a plain-object stand-in, because the shipped cedar examples build
against the cedar serializer alone.

## The lifecycle surface

`describeResources()`, `observeAmbient()` and `exportResources()` read a live
policy store. Point them at one with `CEDAR_AVP_POLICY_STORE_ID` (or
`CEDAR_AVP_POLICY_STORE_ID_<ENV>`), or a `policyStoreId` prop on a declared
policy.

The link from a chant entity to a live policy is the Cedar `@id` annotation,
which is derived from the export name (`ownerRead` → `owner-read`) unless
`annotations.id` overrides it. Rename an export and the observation follows it;
rename it *and* pin `annotations.id` and the live policy stays matched.

## Rules

- **Do not write the statement as prose.** A hand-typed
  `"permit(principal, action, resource);"` in an AVP resource is the exact thing
  this lexicon exists to remove, and the meta-policy wall (see the
  `chant-cedar-meta-policy` skill) fails a bare permit in a prod build.
- **Do not try to tag an individual policy.** AVP policy *stores* are taggable;
  individual policies are not — `CreatePolicy` has no tag surface and a policy
  has no ARN. chant's per-policy marker therefore rides in the policy
  description, stamped by passing `ownership` to `avpPolicyDefinition` and read
  back by `describeResources`/`exportResources`. Store tags remain the coarse
  channel. The design record, including what the choice costs, is
  `src/avp/OWNERSHIP.md`.
- **Do not hand-write the description when you want ownership.** Pass
  `ownership` and let the marker be encoded; the description is capped at 150
  characters and the encoder truncates prose rather than the marker, which is
  what keeps a chant-owned policy from silently reading as foreign.
- **Do not treat an ambient permit as housekeeping.** A permit found in a store
  that no source file declares is a standing grant somebody made outside review.
  It is a security finding. `observeAmbient()` reports the statement and its
  effect and stops short of the verdict — the judgement is yours.

## Non-AVP evaluators

AVP is not the only target, and the lexicon does not privilege it. The same
emitted `.cedar` and `policies.cedar.json` feed:

- **cedar-agent** — a standalone Cedar decision service; point it at the policy
  file and the entity store.
- **An embedded `cedar-wasm`** — the package this lexicon already depends on.
  Load the policy text in-process and call `isAuthorized`.
- **Cloudflare-style embeddings** — the same file, read at the edge.

If the deployment target is anything other than AVP, there is no embedding step
at all. Emit the files and ship them.

## Cedar-for-Kubernetes

The CNCF push includes Cedar as a Kubernetes authorizer, with policies as CRDs.
Those kinds belong to the k8s lexicon's CRD sources — the same rule that kept
`helm.cattle.io` out of the k3s lexicon. What the cedar lexicon does there is
lint the policy *text* embedded in those kinds, which is the pattern the ARGO
rules already use.
