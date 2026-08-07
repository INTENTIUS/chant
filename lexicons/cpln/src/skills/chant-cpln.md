---
skill: chant-cpln
description: Declare Control Plane (cpln) infrastructure from chant — the kinds, GVC scoping, links, and what the serializer emits
user-invocable: true
---

# Control Plane with chant

## The shape

Control Plane's hierarchy is two levels, and it decides almost everything else:

```
Org                                          (immutable, cannot be deleted)
├── org-scoped: Secret, Policy, Domain, IpSet
└── GVC — the placement and networking boundary
    ├── Workload
    ├── Identity
    └── VolumeSet
```

This lexicon models those eight kinds. `Gvc`, `Secret`, `Policy`, `Domain` and `IpSet` are org-scoped; `Workload`, `Identity` and `VolumeSet` take a required `gvc`.

```ts
import { Gvc, Workload } from "@intentius/chant-lexicon-cpln";

export const gvc = new Gvc({
  name: "prod",
  spec: {
    staticPlacement: {
      locationLinks: ["/org/acme/location/aws-us-east-1"],
    },
  },
});

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: {
    type: "serverless",
    containers: [{ name: "main", image: "nginx:1.27", ports: [{ number: 8080, protocol: "http" }] }],
    firewallConfig: { external: { inboundAllowCIDR: ["0.0.0.0/0"] } },
  },
});
```

`chant build` emits multi-document YAML for `cpln apply --file`. The `gvc` property becomes the manifest's own `gvc:` key, so the file is self-contained and does not depend on a `--gvc` flag.

## Pass resources, not link strings

Control Plane addresses resources by link. Pass the declared resource where a link is expected and the serializer emits the right one for its kind:

```ts
export const identity = new Identity({ name: "web-identity", gvc: "prod" });

export const web = new Workload({
  name: "web",
  gvc: "prod",
  spec: { identityLink: identity, /* → //gvc/prod/identity/web-identity */ ... },
});
```

This matters most for identities. The bare `//identity/NAME` form reads perfectly naturally, is accepted by the API, and is **silently ignored** — the policy applies cleanly and grants nothing. Only `//gvc/GVC/identity/NAME` works. Passing the resource is how you stop having to remember that (CPL013 catches it if you write the string by hand).

Link forms, when you do need to write one:

| Kind | Link |
|---|---|
| GVC | `//gvc/NAME` |
| Workload / Identity / VolumeSet | `//gvc/GVC/<kind>/NAME` |
| Secret / Policy / Domain / IpSet | `//<kind>/NAME` |
| Location | `/org/ORG/location/<provider>-<region>` |
| Own org's image | `//image/NAME:TAG` |

`cpln://secret/NAME.FIELD` and `cpln://volumeset/NAME` are different things — runtime resolution URIs the container reads, not links between resources.

## Composites

Five, each encoding rules that are easy to violate by omission:

- `GvcEnvironment` — GVC with locations and pull secrets. Pull secrets are GVC-level, not per workload.
- `ServerlessService` — one HTTP port, explicit firewall, autoscaling defaults.
- `CronJob` — schedule, no ports, no knobs cron ignores.
- `StatefulService` — workload + volume set, mounted, with the capacity floor checked.
- `SecretAccess` — identity + policy, GVC-qualified.

## Live state

Every kind carries a free-form `tags` map, and chant stamps its ownership marker there — `chant.intentius.io/managed-by: chant` plus stack and env. That is what makes `chant plan` precise without a state file: a resource carrying the marker is this stack's, one without it is never auto-deleted.

Reading live state needs `CPLN_ORG` and `CPLN_TOKEN` (a service account key, or a JWT). Use the env var, not `--token` — the flag leaks into process listings and logs.

```bash
CPLN_ORG=acme CPLN_TOKEN=$(cat key) chant plan
```

## Things that are immutable

Worth settling before the first apply, because the fix afterwards is delete-and-recreate:

- Workload `type` and `name`.
- VolumeSet `fileSystemType` and `performanceClass` — recreating means data loss.
- The org itself, which cannot be deleted at all without Control Plane support.
