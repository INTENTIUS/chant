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

> **Status:** this ships the app's **Kubernetes manifests**, the **triage
> activities** (the agent — stubbed by default, real Claude when
> `ANTHROPIC_API_KEY` is set), and the Temporal **workflow + worker**. A webhook
> source, a `WatchOp` drift source, and a local `npm run dev` + tutorial land in
> follow-ups ([#232](https://github.com/INTENTIUS/chant/issues/232)). See
> [#74](https://github.com/INTENTIUS/chant/issues/74).

## What's here now

| File | What it is |
|---|---|
| `src/config.ts` | pinned image refs (replace with your own builds) |
| `src/workloads.ts` | chant manifests — the webhook (`WebApp` → Deployment + Service + Ingress + PDB) and the worker (`WorkerPool` → Deployment) |
| `activities/triage.ts` | the triage activities (raw Temporal): `classifyAlert`, `gatherContext`, `proposeRemediation`, `notifyOutcome` |
| `activities/workflow.ts` | the triage workflow: classify → context → propose → approval gate → notify |
| `activities/worker.ts` | the Temporal worker — registers the activities + workflow, connects via the `local` profile |
| `chant.config.ts` | k8s + temporal lexicons, and a local Temporal profile |

```bash
npm install
npm run build      # → k8s.yaml (plain Kubernetes)
npm run lint       # clean
npm run list       # what you declared
npm test           # unit-tests the activities + a time-skipping workflow test
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

## The workflow and worker

`activities/workflow.ts` is the triage workflow (raw Temporal): classify →
gather context → propose → **approval gate** → notify. Safe remediations apply
directly; risky ones wait on the `approve-remediation` signal (up to 12h, then
held). `activities/worker.ts` registers the activities and workflow and connects
using the `local` profile in `chant.config.ts`.

Run it against a local Temporal:

```bash
temporal server start-dev        # separate terminal
npm run worker                   # polls the task queue
```

A time-skipping test (`activities/workflow.test.ts`) covers the workflow in CI:
phase order, the gate clearing on the signal, the safe path skipping the gate,
and an unapproved risky remediation waiting out the 12h gate.

## Coming in follow-ups

- A webhook source, and a `WatchOp` that turns drift on the deployed namespace
  into a second event source.
- A local k3d + Temporal `npm run dev` and a tutorial
  ([#232](https://github.com/INTENTIUS/chant/issues/232)).
