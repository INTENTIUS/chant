# alert-triage — L5, the golden example capstone

An incident-triage app, and the final level (L5) of the
[golden teaching example](../getting-started/). Where L1–L4 take the same small
workload from synthesis up through the lifecycle dial, L5 graduates to a real
app: a webhook receives alerts, a chant Op runs a phased triage over each, and a
human clears the remediation before anything is applied.

The triage is a chant Op whose steps shell out to this project's own code. The
classifier and the agent are app logic, not infra verbs, so they stay plain
async functions in `activities/triage.ts` with their own unit tests;
`activities/run-triage.ts` sequences them either side of the gate, and
`ops/triage.op.ts` is the three-phase Op that runs both halves.

> **Status:** complete and runnable locally — chant manifests, the triage steps
> (the agent — stubbed by default, real Claude when `ANTHROPIC_API_KEY` is set),
> the Op and its gate, two event sources (webhook + drift), and an
> `npm run dev` local stack. See the
> [tutorial](/chant/tutorials/alert-triage-local/) and
> [#74](https://github.com/INTENTIUS/chant/issues/74).

## What's here now

| File | What it is |
|---|---|
| `src/config.ts` | pinned image refs (replace with your own builds) |
| `src/workloads.ts` | chant manifests — the webhook (`WebApp` → Deployment + Service + Ingress + PDB) and the triage runner (`WorkerPool` → Deployment + PDB, no RBAC) |
| `activities/triage.ts` | the triage steps: `classifyAlert`, `gatherContext`, `proposeRemediation`, `applyRemediation` (stubbed), `notifyOutcome` |
| `activities/run-triage.ts` | the CLI the Op shells: `propose` before the gate, `apply` after it |
| `activities/triage-state.ts` | the two files a triage in flight keeps under `.chant/triage/` |
| `ops/triage.op.ts` | the Op: Propose → Approve (gate) → Remediate |
| `app/parse.ts` | pure event→`Alert` mappers (webhook body and drift entry), unit-tested in `app/parse.test.ts` |
| `app/start-triage.ts` | stage the alert, run the Op, read exit 3 as "waiting on a human" |
| `app/webhook.ts` | event source #1 — HTTP receiver, `POST /alert` starts a triage |
| `app/drift-source.ts` | event source #2 — `chant lifecycle plan --json` → triage each drifted resource |
| `app/demo.ts` | a synthetic alert (`npm run alert`) |
| `chant.config.ts` | the k8s lexicon, the source dir, and the ownership marker |

## Run it locally

```bash
npm install
npm run dev        # webhook + a demo alert
```

The demo alert reaches the gate, so the run ends `gated` with exit 3 and the
proposal is sitting in `.chant/triage/current.json`. Read it, then clear it and
run again:

```bash
cat .chant/triage/current.json
chant approve triage approve-remediation --approver you
chant run triage
```

Nothing was held open between those two commands. A gate is a fact on chant's
ledger: the first run wrote "waiting on approve-remediation", the approve wrote
the resolution, and the second run read both and walked through.

See the [Alert Triage (local) tutorial](/chant/tutorials/alert-triage-local/) for
the full walk-through. Other scripts:

```bash
npm run build      # → k8s.yaml — also prints post-synth hardening advisories
npm run lint       # the gate — clean
npm run alert      # send another alert via the webhook
npm run drift -- --demo   # the drift event source
npm test           # unit tests for the triage steps and the event mappers
```

`npm run build` prints a few post-synth **advisories** (imagePullPolicy and
`readOnlyRootFilesystem` on the two workloads). Those are guidance, not failures
— `npm run lint` is the gate, and it is clean. Hardening the workloads against
the advisories is a good exercise.

## The triage steps

One alert in, a phased triage out: classify severity, gather context, propose a
remediation, stop for a person, then apply and notify. The steps are
deterministic by default, so they run in CI and offline with no key:

- `classifyAlert` — severity from the alert text.
- `gatherContext` — stands in for a tool registry (kubectl, logs, dig).
- `proposeRemediation` — **stub by default; real Claude when `ANTHROPIC_API_KEY`
  is set** (and `@anthropic-ai/sdk` is installed). The first run shows chant, not
  an LLM. Override the model with `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).
  The agent may only *escalate* risk, never de-escalate: a high/critical alert
  is always marked risky even if the model calls it SAFE.
- `applyRemediation` — **clearly stubbed.** A real build would run the change
  (kubectl, a runbook, an API call); here it just logs. The Op reaches it only
  after the gate resolves, so it marks the proposed-vs-executed boundary.
- `notifyOutcome` — logs the outcome; a real build would post to Slack.

## The Op and its gate

`ops/triage.op.ts` is three phases: **Propose → Approve (gate) → Remediate**.
The proposal is written to `.chant/triage/current.json` between them, so the
change that gets applied is the one somebody actually read — not a fresh
classification that moved under them in the meantime.

Every remediation passes the gate, which is a change from the workflow this
replaces. That workflow paid for its gate with a twelve-hour open wait, so it
spent that only on remediations the classifier called risky and let the routine
ones through unattended. A gate is a fact on the ledger now: nothing is held
open between the two runs, and the second is just another run, so there is no
cost left to route everything through it. `risky` still does work — it is what
the proposal and the notify line say about the change being cleared.

Exit 3 is how a caller tells the two apart. `app/start-triage.ts` reads it as
"waiting on a human" rather than a failure, which is what lets the webhook
answer `202` with a status instead of a `500`.

## Two event sources

Both start the same Op:

- **Webhook** (`app/webhook.ts`, `npm run webhook`) — `POST /alert` with a
  Datadog/PagerDuty-shaped body. This is what the `WebApp` manifest deploys.
- **Drift** (`app/drift-source.ts`, `npm run drift`) — runs
  `chant lifecycle plan --json` and triages each drifted resource, so out-of-band
  cluster changes get the same triage as external alerts (the runtime counterpart
  of a scheduled `WatchOp`). `npm run drift -- --demo` injects a sample drift.

## Deploying the manifests

`src/` is typed chant — `npm run build` emits plain `k8s.yaml` you can
`kubectl apply` to any cluster (e.g. local k3d). The manifests reference
placeholder images; swap in your own runner/webhook builds to run in-cluster. The
`npm run dev` flow above runs them from source without images.
