# layered-config — one composite, many environments

> **New to chant?** Start with the [golden teaching example](../../../../examples/getting-started/); this is a focused feature example.

How to deploy **one composite across several environments** with per-environment
differences — using nothing but plain TypeScript object spread. No `deepMerge`
helper, no per-environment files, no codegen.

## The idea

Configuration is layered in two steps, both static:

- `...base` — shallow-merge the base config, override what differs.
- `...base.labels` — deep-merge a nested object with native nested spread.

`src/config.ts` defines one `base` and three environments (`dev`, `staging`,
`prod`) layered over it. `src/web.ts` instantiates the **same** `WebApp`
composite once per environment. Each environment gets a distinct name
(`web-dev` / `web-staging` / `web-prod`), so all three build into one manifest
without collisions.

```
src/config.ts   base + dev/staging/prod layers (object spread)
src/web.ts      WebApp(dev) / WebApp(staging) / WebApp(prod)
```

## Why this works without a merge helper

chant's evaluability rules (EVL) require resource inputs to resolve to static
data. Object spread from a `const` qualifies:

- `{ ...base, replicas: 6 }` — const spread, **allowed**.
- `{ ...base.labels, "acme.io/env": "prod" }` — static member-access spread,
  **allowed** (only a *computed* `config[key]` access is rejected, by EVL003).
- `deepMerge(base, prod)` — a **function call** initializer, which EVL would
  reject. That is exactly why the pattern uses native spread instead.

Presets are the single-level case of this; layered config is the multi-level
generalization, in the language you already have.

## What varies per environment

| | dev | staging | prod |
|---|---|---|---|
| replicas | 2 | 3 | 6 |
| cpu limit | 250m | 500m | 1 |
| memory limit | 256Mi | 512Mi | 1Gi |
| ingress | — | staging.acme.example | acme.example |
| PodDisruptionBudget | — | minAvailable 1 | minAvailable 2 |
| `labels."acme.io/env"` | dev | staging | prod |
| `labels."acme.io/tier"` | — | — | critical |

The `securityContext` is a base-only nested object — every environment inherits
it unchanged (not every nested layer needs a per-environment override).

## Run it

```bash
npm install
npm run build      # → k8s.yaml (3 environments' resources)
npm run lint       # the gate — clean
```

`chant build` also prints a couple of post-synth **advisories** (no explicit
`imagePullPolicy`; the single-replica dev Deployment has no PodDisruptionBudget).
Those are guidance, not failures — `chant lint` is the gate, and it is clean.

## Inspecting one environment

To see the fully-resolved config for a single environment without merging the
layers by hand, use [`chant describe`](/chant/cli/describe/):

```bash
chant describe prodApp src      # effective merged props + resources for prod
chant describe prodApp src --format json
```

