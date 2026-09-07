# getting-started — the golden teaching example

The one example that teaches chant from the core up. It is built in levels. Each
level adds one capability over the **same declarations**, so you start with pure
synthesis and end with a full deployment workflow without rewriting anything. The
whole arc is Kubernetes, and every level runs on a laptop.

Start here if you are new to chant. Stop at whatever level answers your question.

> **Status:** L1–L5 are all here. L1–L4 live in this directory; L5 is the
> [alert-triage app](../alert-triage/). See
> [#216](https://github.com/INTENTIUS/chant/issues/216) for the design.

## The levels

| Level | Adds | Needs |
|---|---|---|
| **L1 — synthesis** (this directory) | typed resources → `chant build` → plain Kubernetes YAML, plus `chant lint` and `chant list` | nothing — no cluster, no cloud |
| **L2 — Ops, local** | wrap the declarations in an Op that `kubectl apply`s to a local k3d cluster | k3d (Docker) |
| **L3 — the gate** | a human-approval gate before apply | the k3d cluster |
| **L4 — the lifecycle dial** | observe drift, reconcile, apply against the cluster | the k3d cluster |
| **L5 — capstone** | the [alert-triage app](../alert-triage/) ([#74](https://github.com/INTENTIUS/chant/issues/74)) — chant manifests + a triage Op with its own gate, two event sources (webhook + drift), and an `npm run dev` local stack | the full local stack |

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
workflow. `chant run deploy` runs it in-process, building the manifests and
applying them to your current kube context. Point that context at a local k3d
cluster:

```bash
# One-time: a throwaway local cluster.
k3d cluster create getting-started

# Build the manifests, then kubectl apply them — phased, with retries.
npm run deploy        # → chant run deploy
```

The Op has two phases: **Build** (`npm run build` → `k8s.yaml`) and **Apply**
(`kubectl apply -f k8s.yaml`). Same declarations as L1 — L2 only adds how they
are operated. L3 adds the one thing an apply to production actually needs: a
person.

This deploy step is not run in CI (there is no cluster there). CI validates that
the Op *compiles* to a well-formed workflow; running it is this local step.

## L3 — stop for approval

`deploy-gated.op.ts` is the same deploy with one addition: an **approval gate**
before the apply, plus a rollback if anything fails. Phases:
**Build → Approve (gate) → Apply**, with an `onFailure` **Rollback**.

A gate is a fact, not a wait. The run reads chant's gate ledger for a
resolution; finding none, it records that this gate is pending and ends. Nothing
is held open, nothing has to be resumed, and no runtime beyond this process is
involved:

```bash
chant run deploy-gated
```

```
[phase] Build
  ✓ chantBuild(path=.)   5.3s
[phase] Approve
  • gate:approve-deploy()   skipped
[phase] Apply
  • kubectlApply(manifest=k8s.yaml)   skipped
Op "deploy-gated" is gated on "approve-deploy" after 7.0s
  Approve applying the getting-started manifests to the cluster
  approve : chant approve deploy-gated approve-deploy
  expires : 2026-09-07T17:40:32.341Z
```

That run exits **3** — its own code, so a CI job can tell "waiting on a person"
from a broken op and retry one without the other. Record the resolution, then
run it again:

```bash
chant approve deploy-gated approve-deploy --approver you
chant run deploy-gated
```

```
[phase] Build
  ✓ chantBuild(path=.)   3.6s
[phase] Approve
  ✓ gate:approve-deploy()   13ms
    [approved] alex at 2026-09-06T17:40:43.427Z
[phase] Apply
  ✓ kubectlApply(manifest=k8s.yaml)
```

The second run re-reads the ledger, finds a resolution newer than the pending
fact, walks through the gate carrying the approver, and applies. A resolution
from before the pending fact does not count — approving in advance does not
pre-authorize a gate that has since been recorded — so the answer always
belongs to the question that was asked. The expiry on the pending fact is the
other half of that: an unanswered gate goes stale rather than standing open
forever, and the next run records a fresh one.

L2's `deploy` stays the ungated path. As with L2, CI validates the Op compiles;
the apply half of this walkthrough needs the cluster.

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
chant run observe                # one observation, now
chant run reconcile              # pull live drift back into source as a PR
chant run apply                  # push declared source to the cluster
```

`observe` carries a cron (`0 * * * *`). A bare `chant run observe` is still one
observation; who honours the cadence is the next section.

You turn the dial up per environment as trust allows. chant hosts no state
file — authority stays with `kubectl`; ownership is read from the marker on each
live resource. As with the other levels, CI validates these Ops compile; running
them needs the cluster.

## Running an agent against this repo

[`agent-guardrails/`](agent-guardrails/) is a safe operating model for pointing an
AI agent (Claude Code) at a chant repo. The idea is the one this whole example
builds toward: the agent produces reviewed diffs, a human deploys.

The repo gitignores `.claude/` and `CLAUDE.md`, so the bundle ships as tracked
sample files you copy into place (see
[`agent-guardrails/README.md`](agent-guardrails/README.md)):

- `settings.json` — permission tiers. Build, lint, and `lifecycle plan` are
  allowed (pure, no credentials). Drift and reconcile are ask-first. The deploy
  Ops (`deploy`, `deploy-gated`, `apply`), their approval signal, and
  `kubectl apply` / `delete` are denied to the agent. A PostToolUse hook runs
  `chant lint` on every edit.
- `agent-instructions.md` — standing facts, becomes `CLAUDE.md`.
- `skills/` — `scaffold-stack` and `drift-check`.

The guardrails constrain an agent working in this directory. You, running the
tutorial by hand, still run the deploy steps above. The point is that chant's
build path needs no credentials, so the agent's whole authoring loop can run
sandboxed, and the one dangerous verb — apply — stays with a human behind a gate.

## Running these Ops somewhere that isn't your laptop

Everything above runs here, in your shell. A schedule does not: a laptop is a
poor place to keep an hourly drift check, and `chant approve` on a production
gate should leave a trail somebody else can read.

`chant run <op> --on fountain` hands the same Op to a
[fountain](https://github.com/BinaryBourbon/fountain) teammate instead. The
command line is posted to that teammate's thread, its sandbox runs it, and the
record comes back in the shape a local run would have written. One teammate per
environment, one thread, so the conversation is that environment's operational
history.

The declaration is small — a `Steward` binds these Ops to a teammate, and turns
each Op's own cron into a schedule on its thread:

```ts
import { params } from "@intentius/chant/params";
import { Environment, Repository, Steward, Vault } from "@intentius/chant-lexicon-fountain";
import observe from "./observe.op";
import deployGated from "./deploy-gated.op";

const toolchain = new Environment({
  name: "getting-started-toolchain",
  repositories: [new Repository({ url: params.repoUrl as string, mount_path: "/workspace/estate", ref: "main" })],
  setup_script: "npm ci && npm install -g @intentius/chant",
  networking_type: "limited",
  networking_config: { allowed_hosts: ["github.com", "registry.npmjs.org"] },
});

export const { agent, teammate, schedules } = Steward({
  name: "getting-started-steward",
  environment: toolchain,
  vault: new Vault({ name: "getting-started-creds" }),
  ops: [observe, deployGated],
});
```

```bash
chant run observe --on fountain           # a turn on the steward's thread
chant run deploy-gated --on fountain      # reaches the gate, ends the turn
chant run approve deploy-gated approve-deploy --on fountain --approver you
chant run status deploy-gated --on fountain
```

`chant run approve ... --on fountain` does both halves itself: it writes the
resolution to the gate ledger, the same fact a local `chant approve` writes,
and then posts `chant run deploy-gated` back onto the steward's thread. The
sandbox re-runs the op, reads the resolution off the ledger, walks through the
gate and applies the manifests. `chant run status` reads that turn back as
`completed`.

The gate behaves exactly as it did on your laptop, which is the point of
gate-as-fact: the run ends its turn with the approve line, and nothing — no
machine, no thread, no process — is pinned by a decision nobody has made yet.

[`fountain-steward`](../fountain-steward/) is the worked example: five
declarations, six fountain resources, and the ACP agent that makes a prompt on
that thread a chant command line.

## A standalone first taste

If you want to run *something* in under a minute with no cluster and no Docker,
the [`local-op-quickstart`](../local-op-quickstart/) example runs a one-step Op
on the local executor (`chant run hello`). It is the smallest Op demo and stands
on its own; this golden example is the guided path that starts from synthesis and
builds up.
