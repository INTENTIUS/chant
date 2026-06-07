# getting-started — the golden teaching example

The one example that teaches chant from the core up. It is built in levels. Each
level adds one capability over the **same declarations**, so you start with pure
synthesis and end with a full deployment workflow without rewriting anything. The
whole arc is Kubernetes, and every level runs on a laptop.

Start here if you are new to chant. Stop at whatever level answers your question.

> **Status:** L1–L4 are here now. L5 lands in follow-up work — see
> [#216](https://github.com/INTENTIUS/chant/issues/216). The level plan below is
> the target shape, not a claim that every level already exists.

## The levels

| Level | Adds | Needs |
|---|---|---|
| **L1 — synthesis** (this directory) | typed resources → `chant build` → plain Kubernetes YAML, plus `chant lint` and `chant list` | nothing — no cluster, no cloud |
| **L2 — Ops, local** | wrap the declarations in an Op that `kubectl apply`s to a local k3d cluster | k3d (Docker) |
| **L3 — gate + Temporal** | a human-approval gate before apply | a local Temporal (Docker) |
| **L4 — the lifecycle dial** | observe drift, reconcile, apply against the cluster | the k3d cluster |
| **L5 — capstone** | the [alert-triage app](../alert-triage/) ([#74](https://github.com/INTENTIUS/chant/issues/74)) — manifests + triage Op so far | the full local stack |

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

## L2 — deploy it locally

`deploy.op.ts` wraps the same L1 declarations in an **Op**: a named, phased
workflow. `chant run deploy` runs it in-process on the local executor — no
Temporal server — building the manifests and applying them to your current kube
context. Point that context at a local k3d cluster:

```bash
# One-time: a throwaway local cluster.
k3d cluster create getting-started

# Build the manifests, then kubectl apply them — phased, with retries.
npm run deploy        # → chant run deploy
```

The Op has two phases: **Build** (`npm run build` → `k8s.yaml`) and **Apply**
(`kubectl apply -f k8s.yaml`). Same declarations as L1 — L2 only adds how they
are operated. Gates, schedules, and crash-resume need `--temporal`; that is L3.

This deploy step is not run in CI (there is no cluster there). CI validates that
the Op *compiles* to a well-formed workflow; running it is this local step.

## L3 — pause for approval (Temporal)

`deploy-gated.op.ts` is the same deploy with one addition: an **approval gate**
before the apply, plus a rollback if anything fails. A gate is a durable
wait-for-signal — it can hold for hours and survives a worker restart — so this
Op runs on **Temporal**, not the local executor (the local executor errors on a
gate, by design). L2's `deploy` stays the fast local path; this is the gated
production shape.

```bash
# A local Temporal in Docker (separate terminal).
temporal server start-dev

# Run on Temporal — pauses at the "Approve" phase.
chant run deploy-gated --temporal

# Release the gate when you're ready.
chant run signal deploy-gated approve-deploy
```

Phases: **Build → Approve (gate) → Apply**, with an `onFailure` **Rollback**.
The Temporal connection comes from the `local` profile in `chant.config.ts`.
As with L2, CI validates the Op compiles; the gated run is this local step.

## L4 — the lifecycle dial

Same declarations, three positions on one dial — `observe → reconcile →
authoritative` — each a composite-generated Op. `chant.config.ts` sets an
`ownership` marker so reconcile and apply can scope to chant-owned resources.

| Op | Direction | What it does |
|---|---|---|
| `observe.op.ts` (`WatchOp`) | — | snapshot + live diff on a schedule; reports drift, changes nothing |
| `reconcile.op.ts` (`ReconcileOp`) | cloud → code | on drift, regenerate the affected TypeScript and open a PR |
| `apply.op.ts` (`ApplyOp`) | code → cloud | apply via `kubectl`; deletes are owned-only (marker-scoped prune) |

```bash
chant run observe --temporal     # scheduled drift detection (needs Temporal)
chant run reconcile              # pull live drift back into source as a PR
chant run apply                  # push declared source to the cluster
```

You turn the dial up per environment as trust allows. chant hosts no state
file — authority stays with `kubectl`; ownership is read from the marker on each
live resource. As with the other levels, CI validates these Ops compile; running
them needs the cluster.

## A standalone first taste

If you want to run *something* in under a minute with no cluster and no Docker,
the [`local-op-quickstart`](../local-op-quickstart/) example runs a one-step Op
on the local executor (`chant run hello`). It is the smallest Op demo and stands
on its own; this golden example is the guided path that starts from synthesis and
builds up.
