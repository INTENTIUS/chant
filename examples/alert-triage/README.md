# alert-triage — L5, the golden example capstone

A Temporal-driven incident-triage app, and the final level (L5) of the
[golden teaching example](../getting-started/). Where L1–L4 take the same small
workload from synthesis up through the lifecycle dial, L5 graduates to a real
app: a webhook receives alerts, a Temporal worker runs a phased triage workflow
over each, and a human approves anything risky before it is applied.

> **Status:** this first slice ships the app's **Kubernetes manifests** and the
> **triage Op skeleton**. The worker, the triage activities (the agent — stubbed
> by default, real Claude when `ANTHROPIC_API_KEY` is set), and a `WatchOp` drift
> source as a second event source land in follow-ups. See
> [#74](https://github.com/INTENTIUS/chant/issues/74).

## What's here now

| File | What it declares |
|---|---|
| `src/config.ts` | pinned image refs (replace with your own builds) |
| `src/workloads.ts` | the webhook (`WebApp` → Deployment + Service + Ingress + PDB) and the worker (`WorkerPool` → Deployment) |
| `alert-triage.op.ts` | the triage Op: **Classify → Context → Propose → Approve (gate) → Notify** |
| `chant.config.ts` | k8s + temporal lexicons, and a local Temporal profile |

```bash
npm install
npm run build      # → k8s.yaml (plain Kubernetes)
npm run lint       # clean
npm run list       # what you declared
```

## The triage workflow

One alert in, a phased triage out. Each non-gate phase is an activity run by the
worker; the `Approve` gate pauses for a human, which makes the Op Temporal-bound:

```bash
chant run alert-triage --temporal              # pauses at "Approve"
chant run signal alert-triage approve-remediation
```

The activities run the agent — **stubbed by default** (no key, runs anywhere),
and a real Claude call when `ANTHROPIC_API_KEY` is set. The first run shows
chant, not an LLM.

## Coming in follow-ups

- The worker and the triage activities (classify / gather context / propose / notify).
- The agent: deterministic stub by default, real Anthropic opt-in.
- A `WatchOp` that turns drift on the deployed namespace into a second event source.
- A local k3d + Temporal `npm run dev` and a tutorial.
