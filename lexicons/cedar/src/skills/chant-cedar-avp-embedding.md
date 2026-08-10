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

## What ships today

The cedar lexicon serializes a policy set to `.cedar` text and to the JSON
policy format. Those are files. Feeding one policy's text into an AVP resource
is a build-time operation over the same serializer:

```typescript
import { Policy, ReadAction } from "@intentius/chant-lexicon-cedar";
import { cedarSerializer } from "@intentius/chant-lexicon-cedar/serializer";

export const ownerRead = new Policy({
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: ReadAction },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
});
```

The statement text for `ownerRead` is what `cedarSerializer.serialize()` emits
for that one entity — the same bytes that go in the `.cedar` file, so the
deployed policy and the reviewed file cannot disagree.

## What is deferred

A typed handoff — a `VerifiedPermissionsPolicy` whose `statement` accepts a
cedar-lexicon `Policy` value directly, rather than a string a caller assembled —
is **landing with INTENTIUS/chant#1652**, along with the policy-store lifecycle
work: `describeResources()`/`observeAmbient()` against a live store, and the
ownership-channel design.

Do not hand-roll a replacement for it. In particular:

- **Do not write the statement as prose.** A hand-typed
  `"permit(principal, action, resource);"` in an AVP resource is the exact thing
  this lexicon exists to remove, and the meta-policy wall (see the
  `chant-cedar-meta-policy` skill) fails a bare permit in a prod build.
- **Do not tag individual policies for ownership.** AVP policy *stores* are
  taggable; individual policies are not. Store-level granularity is the decided
  scope, and no ownership channel is declared until its read paths exist — the
  tier-2 `check-lexicon` gate exists because of exactly this failure mode.
- **Do not treat an ambient permit as housekeeping.** A permit found in a store
  that no source file declares is a standing grant somebody made outside review.
  It is a security finding.

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
