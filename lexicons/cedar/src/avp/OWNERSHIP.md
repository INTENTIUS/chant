# Ownership channel: Amazon Verified Permissions

The design record for chant #1652, epic #1645. The epic left this open ("store-scoped
until proven finer") because the tier-2 check in `chant dev check-lexicon` exists
precisely to stop a lexicon declaring a channel it cannot read.

The full cedar docs site is #1654's. This file is the decision, kept beside the code
that implements it so the two cannot drift.

## The constraint

AVP is the only target chant deploys to where the resource that needs an ownership
marker cannot carry one.

- A **policy store** is taggable. `TagResource` / `ListTagsForResource` take the same
  key/value map every other AWS resource has.
- An **individual policy** is not. `CreatePolicy` accepts a policy store id, a
  definition, and a client token. There is no tag surface on it, and no
  `TagResource` call that accepts a policy ARN, because a policy has no ARN.

That matters because a store is not the unit of ownership. One store holds the
policies from a chant build *and* whatever anyone added in the console, and the whole
reason ownership exists is to let `delete` be precise: an undeclared policy carrying
chant's marker is a safe delete candidate, an undeclared policy without one is
somebody else's grant and must never be touched. A store-level answer cannot make that
distinction for anything inside the store.

## The decision

**Two channels, one set of keys, and only the per-policy one resolves a verdict about
a policy.**

| Channel | Target | Read via | What it answers |
|---|---|---|---|
| Description marker | one policy | `ListPolicies` / `GetPolicy` → `definition.static.description` | is *this policy* chant's |
| Tags | the store | `ListTagsForResource` on the store ARN | is *this store* chant's |

Both use `AVP_OWNERSHIP_KEYS` — `chant:managed-by`, `chant:stack`, `chant:env` — the
same names the aws lexicon stamps into tags. `ownershipChannel` declares one
`ChannelKeys`, and a lexicon whose two channels disagreed on key names would be two
conventions wearing one declaration.

### The encoding

`Definition.Static.Description` is a free-form string, so the marker rides in a
trailing bracketed segment and the author's own text is preserved ahead of it:

```
Owners always read their own documents. [chant:managed-by=chant chant:stack=authz chant:env=prod chant:policy-id=owner-read]
```

- Values are **percent-encoded**, so a stack named `my stack` or an id containing `]`
  round-trips instead of corrupting the segment.
- `chant:policy-id` is recorded beside the marker but is deliberately **not** part of
  `AVP_OWNERSHIP_KEYS`. It is not an ownership claim — `hasOwnershipMarker` must not
  consult it — it is there because `ListPolicies` returns descriptions and not
  statements, so without it every live policy costs a second `GetPolicy` round trip
  just to learn which chant entity it belongs to.
- AVP caps the description at **150 characters**. When the author's text plus the
  marker exceed it, the *text* is truncated and the marker is kept whole. The failure
  direction matters: a dropped marker turns an owned policy into a foreign one, a
  foreign policy is never deleted, and the estate would accumulate undeletable
  policies with nothing reported anywhere.

### Declared read paths

```ts
ownershipChannel: {
  keys: AVP_OWNERSHIP_KEYS,
  reads: ["describeResources", "exportResources"],
}
```

Both are implemented and both genuinely read the description:

- `describeResources` gets it from the `ListPolicies` enumeration it already runs, so
  the verdict costs nothing extra. Every returned resource carries `owned` or
  `foreign`; with `owned: true`, a policy without the marker becomes NOT-OBSERVED with
  reason `filtered` rather than disappearing (it exists — it just isn't chant's, and a
  declared resource that exists must not classify as `create`).
- `exportResources` reads the same field to implement its `owned` filter.

`observeResourcesDeep` is **not** declared, because this lexicon does not implement it.
That is the whole point of the per-path declaration (chant #1348): a caller learns
before asking whether `owned: true` is answerable on the path it is about to use.

### Where the verdict is `unknown`

Ownership verdicts are total, so every path that cannot read the marker says `unknown`
rather than degrading silently. In practice this reader never returns a resource whose
description it did not read — if the enumeration failed, the entity is NOT-OBSERVED,
not present-with-an-unknown-verdict — so `unknown` shows up only where core stamps it
for a lexicon that reported nothing. The obligation is still real for anyone extending
this file: a new read path that cannot see the description must not be added to
`reads`.

## Reading the store: the signing seam

The reader was an emulator-and-test transport when #1652 landed, because its requests
were unsigned and real AWS rejects those. SigV4 now exists in the aws lexicon
(`lexicons/aws/src/api/sigv4.ts`, chant #1686) and `src/avp/client.ts` uses it — through
a function on `AvpClientOptions`, not through an import.

The reason is the same one that kept `src/avp/embed.ts` free of the aws lexicon: a
cedar → aws dependency edge would make the vendor-neutral lexicon unbuildable without
the AWS one, for the sake of a transport most Cedar deployments never use. So
`AvpSigner`, `AvpCredentials` and `AvpSignableRequest` restate the aws lexicon's own
shapes, and `signRequest` satisfies `AvpSigner` as it stands. A project that has both
lexicons installed wires them where it already builds the client options:

```ts
import { signRequest } from "@intentius/chant-lexicon-aws";
import { describeAvpResources } from "@intentius/chant-lexicon-cedar";

await describeAvpResources({
  environment,
  entityNames,
  entities,
  client: { region: "us-west-2", signer: signRequest },
});
```

The cost of restating rather than importing is that a shape change in the aws lexicon
shows up as a type error in the consumer that wires the two, not here. That is the
trade the decoupling buys, and it is why the two files name each other in prose.

Unsigned stays the default, and three cases stay unsigned regardless: no signer wired
in, no credentials resolved, and an endpoint override without `signEndpointOverride`
(an emulator does not verify signatures, and signing against one would make every local
lane need credentials to read what it just deployed). An override is the `endpoint`
option, else `AWS_ENDPOINT_URL_VERIFIEDPERMISSIONS`, else `AWS_ENDPOINT_URL` — the SDK's
precedence, and the rule the aws lexicon's read client applies (#1694); it is restated
in `resolveEndpointOverride` for the same reason the signer shapes are. `credentialsAvailable` therefore
still gates the readers exactly as before — a caller that wires nothing in gets every
entity NOT-OBSERVED with `no-credentials` rather than a request that was never going to
work.

## Alternatives rejected

**Store-level tags as the only channel.** The epic's provisional position. Rejected
because it answers a question nobody asks: `lifecycle plan` needs to know whether
*this policy* is deletable, and "the store is chant's" says nothing about the console
edit sitting inside it. Kept as the coarse channel (`ownershipFromStoreTags`) because
it is real information about the store, and free.

**A Cedar annotation, `@chant_managed("chant")`, inside the policy text.** Attractive:
it is in the artifact, it survives any transport, and it needs no second field. Rejected
because it changes the walk-away artifact. The epic's test is that an emitted policy
set is consumed by any Cedar evaluator with chant nowhere in sight, and an annotation
chant invented is chant in sight — it would show up in every export, every `.cedar`
file, and every console view of the policy. The description is metadata *about* the
policy in AVP's own model; the statement is the product.

**A separate policy-store-scoped index (a marker policy, or an S3 object).** That is a
state file with extra steps, and the lifecycle model exists specifically so ownership
lives on the resource rather than in something chant has to host and lock.

## Cost, stated plainly

The description is user-writable. Someone can edit it in the console and a chant-owned
policy becomes `foreign`, which means chant stops offering to delete it — noticeable,
and safe. The reverse is also possible: pasting chant's marker onto a foreign policy
makes chant willing to delete it. Tags have exactly the same property, so this is the
ordinary AWS trust model rather than a new weakness, but the description is more likely
to be edited by hand than a tag is. Worth knowing before turning on `--owned`
reconciliation against a shared store.
