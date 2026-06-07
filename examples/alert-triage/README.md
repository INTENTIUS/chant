# alert-triage — L5, the golden example capstone

A Temporal-driven incident-triage app, and the final level (L5) of the
[golden teaching example](../getting-started/). Where L1–L4 take the same small
workload from synthesis up through the lifecycle dial, L5 graduates to a real
app: a webhook receives alerts, a Temporal worker runs a phased triage workflow
over each, and a human approves anything risky before it is applied.

The triage workflow is **raw Temporal**, not a chant Op — its activities are
custom app logic (they run the agent), so it's a hand-written Temporal
workflow + worker, with chant synthesizing the Kubernetes manifests around it.
This is chant's documented "Raw Temporal + chant" path, the same split as
`temporal-crdb-deploy`. (chant Ops are for infra-deploy workflows over pre-built
steps, not arbitrary app logic.)

> **Status:** so far this ships the app's **Kubernetes manifests** and the
> **triage activities** (the agent — stubbed by default, real Claude when
> `ANTHROPIC_API_KEY` is set). The Temporal **workflow + worker** wiring, a
> webhook source, and a `WatchOp` drift source land in follow-ups. See
> [#74](https://github.com/INTENTIUS/chant/issues/74).

## What's here now

| File | What it is |
|---|---|
| `src/config.ts` | pinned image refs (replace with your own builds) |
| `src/workloads.ts` | chant manifests — the webhook (`WebApp` → Deployment + Service + Ingress + PDB) and the worker (`WorkerPool` → Deployment) |
| `activities/triage.ts` | the triage activities (raw Temporal): `classifyAlert`, `gatherContext`, `proposeRemediation`, `notifyOutcome` |
| `chant.config.ts` | k8s + temporal lexicons, and a local Temporal profile |

```bash
npm install
npm run build      # → k8s.yaml (plain Kubernetes)
npm run lint       # clean
npm run list       # what you declared
npm test           # unit-tests the triage activities
```

## The triage activities

One alert in, a phased triage out: classify severity, gather context, propose a
remediation, and (in the workflow) gate on human approval for risky changes,
then notify. The activities are deterministic by default, so they run in CI and
offline with no key:

- `classifyAlert` — severity from the alert text.
- `gatherContext` — stands in for a tool registry (kubectl, logs, dig).
- `proposeRemediation` — **stub by default; real Claude when `ANTHROPIC_API_KEY`
  is set** (and `@anthropic-ai/sdk` is installed). The first run shows chant, not
  an LLM. Override the model with `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).
- `notifyOutcome` — logs the outcome; a real build would post to Slack.

## Coming in follow-ups

- The raw Temporal **workflow** (classify → context → propose → approval gate →
  notify) and the **worker** that registers these activities.
- A webhook source, and a `WatchOp` that turns drift on the deployed namespace
  into a second event source.
- A local k3d + Temporal `npm run dev` and a tutorial.
