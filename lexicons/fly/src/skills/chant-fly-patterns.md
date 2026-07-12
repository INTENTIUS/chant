---
skill: chant-fly-patterns
description: Volumes and mounts, IP assignments, certificates, apply-only secrets, and the app-boundary ownership model for Fly
user-invocable: true
---

# Fly Resource Patterns

Beyond the App and Machine covered in `chant-fly`, the lexicon models `Volume`, `IPAddress`, `Certificate`, and `Secret`. This skill covers how they apply and prune, and the ownership boundary that makes prune safe.

## Volumes and mounts

`flyApply` applies volumes before machines, because a machine's `config.mounts[]` references a volume by name, so the volume must exist first. A volume is created if absent (idempotent by name); a re-apply of an existing volume is a no-op.

The FLY011 build check enforces the link statically: every machine mount must reference a `Volume` declared in the stack, checked across files. A mount that points at an undeclared volume fails `chant build` before anything reaches the API.

```ts
import { App, Machine, MachineConfig, MachineGuest, Volume, Fly } from "@intentius/chant-lexicon-fly";

export const app = new App({ name: "my-app", org_slug: Fly.OrgSlug });

export const data = new Volume({ name: "data", region: "iad", size_gb: 10 });

export const web = new Machine({
  name: "web",
  region: "iad",
  config: new MachineConfig({
    image: "flyio/hellofly:latest",
    guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
    mounts: [{ volume: "data", path: "/data" }],
  }),
});
```

## IP assignments

An IP is assigned if the declared type is not already present, keyed by family (shared v4, dedicated v4, or v6). Because the address is server-allocated, a re-apply of the same declared type is a no-op rather than a second assignment.

## Certificates

A certificate is created if absent, idempotent by hostname. A re-apply for a hostname that already has a certificate is a no-op.

## Apply-only secrets

Secrets are apply-only. flaps returns only a digest for a secret, never the value, so there is nothing to read back for a diff. `flyApply` always POSTs a declared secret and excludes it from any drift comparison, so every apply re-sets it. Secret values may not be written inline in machine config (the FLY004 build check rejects that); declare them as a `Secret` or a reference.

```ts
import { Secret } from "@intentius/chant-lexicon-fly";

// The value comes from the environment or a reference, not a literal in source.
export const dbUrl = new Secret({ name: "DATABASE_URL", value: process.env.DATABASE_URL! });
```

## The app-boundary ownership model

Ownership is asymmetric, by design:

- Machines carry `config.metadata`, so they get the primary marker `managed-by: chant`. Prune filters on it, so a foreign machine in the same app is never touched.
- Volumes, IPs, certificates, and secrets carry no arbitrary metadata, so they have no marker channel. Their ownership boundary is the app itself, the way a CloudFormation stack owns its resources: everything under a chant-managed app is treated as chant's, and prune for these types is app-scoped. Anything live that the plan no longer declares under that app is removed.

The limitation: because these four types have no marker, a volume, IP, certificate, or secret created out of band inside a chant-managed app is indistinguishable from a chant one and can be pruned. That is the price of app-boundary ownership. The safeguard is that an app is only ever chant-managed when it carries the marker through its machines. Do not enable prune on an app that mixes chant-declared and hand-created volumes, IPs, certificates, or secrets, and never widen app-scoped prune beyond a single chant-declared app.

## Apply order

`flyApply` applies in dependency order and prunes last:

1. Apps.
2. Volumes (before machines, so mounts resolve).
3. Machines (create or update, then wait for `started`; updates go through a lease).
4. IPs, certificates, secrets (independent of machines).
5. Prune, if enabled: machines owned-only by marker; volumes, IPs, certificates, and secrets app-scoped.
