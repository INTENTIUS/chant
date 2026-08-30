# @intentius/chant-lexicon-cpln

[Control Plane](https://controlplane.com) (cpln) lexicon for [chant](https://github.com/intentius/chant) — GVCs, workloads, identities and secrets as typed TypeScript.

Types are generated from Control Plane's served OpenAPI document, so they track the real API.

```bash
npm install --save-dev @intentius/chant-lexicon-cpln
```

## What it looks like

```typescript
import { GvcEnvironment, ServerlessService } from "@intentius/chant-lexicon-cpln";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org: "acme",
  locations: ["aws-us-east-1"],     // placement is GVC-level
});

export const { workload } = ServerlessService({
  name: "web",
  gvc: "prod",
  image: "nginx:1.27",
  port: 8080,
  inboundAllowCidr: ["0.0.0.0/0"],  // the firewall starts closed
});
```

`chant build` emits multi-document YAML for `cpln apply --file`. Each document carries its own `gvc:` key, so the file is self-contained rather than depending on a `--gvc` flag.

## The kinds

Org-scoped: `Gvc`, `Secret`, `Policy`, `Domain`, `IpSet`.
GVC-scoped (each takes a required `gvc`): `Workload`, `Identity`, `VolumeSet`.

Org-administration kinds (`group`, `serviceaccount`, `cloudaccount`, `auditctx`, `agent`, `user`) and `mk8s` are not modelled yet — each is a row in `src/kinds.ts` away, and `chant cpln coverage` reports the gap rather than hiding it.

## What the checks are for

Control Plane accepts several plausible-looking configurations and then quietly does nothing with them. The 22 CPL rules are weighted toward exactly those:

| | |
|---|---|
| `CPL013` | A policy binding against `//identity/NAME` is accepted and **silently ignored** — only `//gvc/GVC/identity/NAME` grants anything |
| `CPL014` | `cpln://secret/db` with no `.field` resolves to nothing at runtime |
| `CPL026` | `minScale: 0` on a strategy that cannot scale to zero holds at one replica, with no error |
| `CPL027` | Capacity AI is on by default and conflicts with CPU autoscaling, multi-metric autoscaling, and GPUs |
| `CPL023` | `memory(MiB) / cpu(millicores)` must be ≤ 8 — a memory-heavy, CPU-light workload is rejected |

Passing a declared resource where a link belongs sidesteps the first of these entirely: the serializer emits the correct link for its kind, GVC qualifier included.

## Live state

Every kind carries a free-form `tags` map, which is where chant stamps its ownership marker. That is what makes `chant plan` precise without a state file.

```bash
CPLN_ORG=acme CPLN_TOKEN=$(cat sa-key) chant plan
```

Use the env var rather than `--token`; the flag leaks into process listings and logs.

## Development

```bash
just generate    # regenerate types from the upstream spec
just validate    # check the generated artifacts
just snapshot    # refresh the committed offline spec snapshot
just docs        # build and serve the docs site
```

## Project structure

- `src/kinds.ts` — the kind table every subsystem agrees on
- `src/plugin.ts` — the `LexiconPlugin` entry point
- `src/serializer.ts` — `cpln apply` manifest output
- `src/spec/` — OpenAPI fetch, offline snapshot, and parser
- `src/codegen/` — generation pipeline, naming, packaging, docs
- `src/lint/` — source-level rules, post-synth checks, audit catalog
- `src/composites/` — `GvcEnvironment`, `ServerlessService`, `CronJob`, `StatefulService`, `SecretAccess`, `PublicDomain`
- `src/describe-resources.ts` — live observation
- `src/generated/` — generated artifacts (do not edit)

[Full documentation →](https://intentius.io/chant/lexicons/cpln/)
