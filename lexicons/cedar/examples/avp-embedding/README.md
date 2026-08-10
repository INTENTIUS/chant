# avp-embedding

A policy set that ships two ways from one source: as `.cedar` text for any Cedar
evaluator, and as the `Definition` property `AWS::VerifiedPermissions::Policy`
takes.

```
npx chant build src
```

`src/policies.ts` declares three `Policy` entities. `chant build` writes them to
`.cedar` and to the JSON policy set. The `avpPolicies` export in the same file
renders the same declarations through `avpPolicyDefinition()` — the AVP
embedding — so the statement AWS evaluates and the statement in the `.cedar`
file are produced by one renderer and cannot drift.

## The seam

`avpPolicyDefinition(name, props, options)` returns

```jsonc
{
  "Static": {
    "Statement": "@id(\"owner-read\")\npermit (\n  principal is App::User,\n  ...\n);",
    "Description": "Owners read their own documents. [chant:managed-by=chant chant:stack=authz chant:env=prod chant:policy-id=owner-read]"
  }
}
```

which is exactly the `Definition` prop of the aws lexicon's generated
`VerifiedPermissionsPolicy` (required props: `PolicyStoreId`, `Definition`).

**The cedar lexicon does not depend on the aws lexicon.** Cedar is
vendor-neutral and AVP is one evaluator among several — Cloudflare, MongoDB,
`cedar-agent` and an embedded `cedar-wasm` all consume the same text. So the
seam is the data shape, not an import.

This example therefore uses a plain-object stand-in with the generated class's
own prop names. A project that installs both lexicons swaps one line:

```ts
import { VerifiedPermissionsPolicy } from "@intentius/chant-lexicon-aws";

export const ownerReadPolicy = new VerifiedPermissionsPolicy({
  PolicyStoreId: policyStore.ref(),
  Definition: avpPolicyDefinition("ownerRead", ownerReadProps),
});
```

The stand-in is not a shortcut around a missing capability — it is what the
example harness allows. The shipped cedar examples build against the cedar
serializer alone, so an `AWS::*` entity declared in this tree would have no
serializer to emit it and the build would report it as unhandled.

## The description marker

Passing `ownership` stamps chant's ownership marker into the AVP description.
That is the per-policy ownership channel: AVP policy stores are taggable and
individual policies are not, so the description is the only durable place a
per-policy marker can live. It is what lets `chant lifecycle` tell a policy this
build owns from one somebody added in the console, and it is read back by
`describeResources()` and `exportResources()`.

The full design record, including the two rejected alternatives and what the
channel costs, is in `src/avp/OWNERSHIP.md`.
