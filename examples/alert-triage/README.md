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

> **Status:** complete and runnable locally — chant manifests, triage activities
> (the agent — stubbed by default, real Claude when `ANTHROPIC_API_KEY` is set),
> the Temporal workflow + worker, two event sources (webhook + drift), and an
> `npm run dev` local stack. See the
> [tutorial](/chant/tutorials/alert-triage-local/) and
> [#74](https://github.com/INTENTIUS/chant/issues/74).

## What's here now

| File | What it is |
|---|---|
| `src/config.ts` | pinned image refs (replace with your own builds) |
| `src/workloads.ts` | chant manifests — the webhook (`WebApp` → Deployment + Service + Ingress + PDB) and the worker (`WorkerPool` → Deployment) |
| `activities/triage.ts` | the triage activities (raw Temporal): `classifyAlert`, `gatherContext`, `proposeRemediation`, `notifyOutcome` |
| `activities/workflow.ts` | the triage workflow: classify → context → propose → approval gate → notify |
| `activities/worker.ts` | the Temporal worker — registers the activities + workflow, connects via the `local` profile |
| `app/webhook.ts` | event source #1 — HTTP receiver, `POST /alert` starts a triage workflow |
| `app/drift-source.ts` | event source #2 — `chant lifecycle diff --live` → triage each drifted resource |
| `app/demo.ts` | a synthetic alert (`npm run alert`) |
| `chant.config.ts` | k8s + temporal lexicons, and a local Temporal profile |

## Run it locally

```bash
npm install
npm run dev        # Temporal dev server + worker + webhook + a demo alert
```

Open the Temporal UI at **http://localhost:8233**. The demo alert is risky, so it
pauses at the approval gate; release it with:

```bash
temporal workflow signal -n default --query "WorkflowType='alertTriage'" --name approve-remediation
```

See the [Alert Triage (local) tutorial](/chant/tutorials/alert-triage-local/) for
the full walk-through. Other scripts:

```bash
npm run build      # → k8s.yaml (plain Kubernetes)
npm run lint       # clean
npm run alert      # send another alert via the webhook
npm run drift -- --demo   # the drift event source
npm test           # unit tests + a time-skipping workflow test
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

## Two event sources

Both start the same triage workflow:

- **Webhook** (`app/webhook.ts`, `npm run webhook`) — `POST /alert` with a
  Datadog/PagerDuty-shaped body. This is what the `WebApp` manifest deploys.
- **Drift** (`app/drift-source.ts`, `npm run drift`) — runs
  `chant lifecycle diff --live` and triages each drifted resource, so out-of-band
  cluster changes get the same triage as external alerts (the runtime counterpart
  of a scheduled `WatchOp`). `npm run drift -- --demo` injects a sample drift.

## Deploying the manifests

`src/` is typed chant — `npm run build` emits plain `k8s.yaml` you can
`kubectl apply` to any cluster (e.g. local k3d). The manifests reference
placeholder images; swap in your own worker/webhook builds to run in-cluster. The
`npm run dev` flow above runs them from source without images.
