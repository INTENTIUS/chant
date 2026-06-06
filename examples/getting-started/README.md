# getting-started — the golden teaching example

The one example that teaches chant from the core up. It is built in levels. Each
level adds one capability over the **same declarations**, so you start with pure
synthesis and end with a full deployment workflow without rewriting anything. The
whole arc is Kubernetes, and every level runs on a laptop.

Start here if you are new to chant. Stop at whatever level answers your question.

> **Status:** L1 is here now. L2–L5 land in follow-up work — see
> [#216](https://github.com/INTENTIUS/chant/issues/216). The level plan below is
> the target shape, not a claim that every level already exists.

## The levels

| Level | Adds | Needs |
|---|---|---|
| **L1 — synthesis** (this directory) | typed resources → `chant build` → plain Kubernetes YAML, plus `chant lint` and `chant list` | nothing — no cluster, no cloud |
| **L2 — Ops, local** | wrap the declarations in an Op that `kubectl apply`s to a local k3d cluster | k3d (Docker) |
| **L3 — gate + Temporal** | a human-approval gate before apply | a local Temporal (Docker) |
| **L4 — the lifecycle dial** | observe drift, reconcile, apply against the cluster | the k3d cluster |
| **L5 — capstone** | the alert-triage app ([#74](https://github.com/INTENTIUS/chant/issues/74)) | the full local stack |

## L1 — what is here

A web Deployment and its Service, declared as typed TypeScript.

| File | Teaches |
|---|---|
| `src/config.ts` | static data — plain `const` values resolved at synthesis, reused across resources |
| `src/web.ts` | typed resources via the `WebApp` composite; one call expands to a Deployment, a Service, and a PodDisruptionBudget |

### Run it

```bash
npm install

# Synthesize plain Kubernetes YAML. No cluster call, no state, no apply.
npm run build      # → k8s.yaml

# Validate meaning, not just structure. Lint is the gate — it must be clean.
npm run lint

# See what you declared.
npm run list
```

`k8s.yaml` is standard Kubernetes. You can `kubectl apply -f k8s.yaml` it, or
hand it to any pipeline — there is nothing chant-specific in the output. That is
the whole of L1: deterministic, spec-true synthesis.

`chant build` also prints post-synth **advisories** (for example, suggesting an
explicit `imagePullPolicy` or a read-only root filesystem). Those are guidance,
not failures — `chant lint` is the gate. Hardening the workload against them is a
good exercise.

## A standalone first taste

If you want to run *something* in under a minute with no cluster and no Docker,
the [`local-op-quickstart`](../local-op-quickstart/) example runs a one-step Op
on the local executor (`chant run hello`). It is the smallest Op demo and stands
on its own; this golden example is the guided path that starts from synthesis and
builds up.
