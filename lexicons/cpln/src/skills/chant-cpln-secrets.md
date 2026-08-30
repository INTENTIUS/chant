---
skill: chant-cpln-secrets
description: Wire Control Plane secrets, identities and policies so a workload can actually read them — the three-step path and its silent failures
user-invocable: true
---

# Control Plane Secrets, Identities and Policies

Control Plane's own documentation calls a partial version of this its **number one support issue**. The reason is worth stating up front: every way of getting it wrong fails *silently at runtime*. The API accepts the broken form, the workload starts, and the failure surfaces later as an application error.

## The three steps

All three are required. Missing any one produces no apply-time error.

**1. The workload has an identity.**

```ts
export const identity = new Identity({ name: "web-identity", gvc: "prod" });

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: { identityLink: identity, /* ... */ },
});
```

**2. A policy grants that identity `reveal` on the secret.**

```ts
export const policy = new Policy({
  name: "web-secrets",
  targetKind: "secret",
  targetLinks: ["//secret/db-password"],
  bindings: [{
    permissions: ["reveal"],
    principalLinks: ["//gvc/prod/identity/web-identity"],
  }],
});
```

**3. The reference is field-qualified.**

```ts
env: [{ name: "DATABASE_PASSWORD", value: "cpln://secret/db-password.payload" }]
```

`SecretAccess` does steps 1 and 2, and `secretRef()` does step 3:

```ts
import { SecretAccess, secretRef } from "@intentius/chant-lexicon-cpln";

export const { identity, policy } = SecretAccess({
  name: "web-identity",
  gvc: "prod",
  secrets: ["db-password"],
});

// → "cpln://secret/db-password.payload"
secretRef("db-password", "payload");
```

## The two silent failures

**The principal link must be GVC-qualified.** `//identity/NAME` is accepted and ignored. Only `//gvc/GVC/identity/NAME` grants anything. (CPL013)

**The secret reference must name a field.** `cpln://secret/db` resolves to nothing:

| Type | Field |
|---|---|
| `opaque` | `.payload` |
| `dictionary` | `.KEY` — one env var per key, or volume-mount the whole thing as a directory |
| `userpass` | `.username`, `.password` |
| `tls` | `.cert`, `.key` |
| `keypair` | `.publicKey`, `.privateKey` |
| `aws` | `.accessKey`, `.secretKey`, `.roleArn` |
| `gcp` | unqualified — conventionally a volume-mounted JSON file |

(CPL014)

## Identities

- **GVC-scoped and not shareable.** An identity cannot be used from another GVC — declare one per GVC with the same spec (CPL029).
- A workload has **at most one**.
- One cloud account per provider: one AWS + one GCP + one Azure, not two AWS.
- Provider sections have XOR rules: AWS `roleName` ⊻ `policyRefs`, GCP `serviceAccount` ⊻ `bindings`. Network resources `IPs` ⊻ `FQDN`.
- **Do not assign one unless the workload needs it** — secret access, credential-free cloud access, or private network access. An empty identity assignment complicates audit traces for no benefit.

## Policies

- `targetKind` is singular and lowercase.
- Pick exactly one scope: `target: "all"`, `targetLinks`, or `targetQuery`.
- `ipset`, `mk8s` and `workloadreplica` are **not** valid targets — they are governed through their parent.
- Max 50 bindings per policy, 200 principal links per binding. Permissions must be sorted alphabetically and unique.
- Never set `origin` — the system sets it, and a declared value reads as drift on every plan. `builtin` policies cannot be modified at all.

Principal forms: `//user/EMAIL`, `//group/NAME`, `//serviceaccount/NAME`, `//gvc/GVC/identity/NAME`.

(CPL043)

## Secret values in source

There are 12 secret types. `cpln secret create` does not exist — the CLI has a `create-<type>` variant for each.

Never put credential material in a chant declaration. CPL001 fires on recognisable credential shapes — private keys, cloud access keys, JWTs, database URLs with inline passwords — at author time, where the finding has a file and a line and the credential has not yet reached git history. CPL012 catches the rest from the model: a credential-named env var set to any literal.

Read the value from the environment at build time, or set it out of band with `cpln secret edit` and leave chant managing only the secret's existence and its type.

## Pull secrets are GVC-level

`spec.pullSecretLinks` on the GVC, not on the workload. Only `docker`, `ecr` and `gcp` types are valid as pull secrets. Images from your own org's registry need none.
