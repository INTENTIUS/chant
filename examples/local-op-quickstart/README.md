# local-op-quickstart

The smallest possible Op — runs in-process with **no server, Docker, or cloud**.

```bash
npm install
chant run hello
```

```
[phase] Greet
  ✓ shellCmd(cmd=echo hello from chant)   8ms
Op "hello" completed in 0.0s
```

`chant run` executes Ops locally: phased, with per-step retries and `onFailure`
compensation. Machine-readable output:

```bash
chant run hello --json
```

## Retry and timeout profiles

`hello`'s one step names a profile — `fastIdempotent` — instead of restating a
timeout and a backoff. The six names live in `ACTIVITY_PROFILES`, exported from
`@intentius/chant/op`, and cover what infra steps actually do:

| Profile | Timeout | Attempts | For |
|---|---|---|---|
| `fastIdempotent` | 5m | 3 | `chant build`, `kubectl apply`, reading status |
| `longInfra` | 20m | 3 | cluster creation, Helm installs, `apply --wait` |
| `k8sWait` | 15m | 3 | rollout and DNS-propagation polling |
| `humanGate` | 48h | 1 | a step waiting on an operator action |
| `argoSync` | 30m | 5 | polling an Argo Application to Healthy/Synced |
| `policyCheck` | 5m | 1 | `policyGate` — deterministic, so no retry |

Tuning lives in that one table rather than inline at every call site. A step
that names no profile takes its builder's own default.

## A gated one-shot migration (effect receipt)

`local-aws-migrate` extends the local-aws loop with a migration that must run
exactly once per input set. The `effect(schemaSeeded, [...])` step reads the
receipt — an `AWS::SSM::Parameter` at
`/chant-receipts/local-op-quickstart/local/demo-schema-seed`, path derived
from `ownership` in `chant.config.ts` — and skips the gated migration when it
already matches. On a mismatch the run reaches the gate, records it pending and
ends `gated` with exit 3; the migration runs on the next run after somebody
records the resolution, and the receipt is written only after it succeeds.

```bash
chant run local-aws-migrate --env local
chant approve local-aws-migrate approve-migration --approver you
chant run local-aws-migrate --env local
```

Nothing is held open between those two runs. A gate is a fact chant reads off
its ledger, not a process waiting somewhere — which is why exit 3 exists as its
own code: a CI job can tell "waiting on a person" from a broken op.

The receipt is plain infrastructure: `aws ssm get-parameter --name
/chant-receipts/local-op-quickstart/local/demo-schema-seed` reads it with
read-only IAM and no chant binary.

## Running an Op somewhere else

`chant run <op>` executes here. `chant run <op> --on fountain` hands the same
Op to a fountain teammate instead: the command line is posted to that
teammate's thread, the sandbox runs it, and the record comes back in the shape
a local run would have written. That is where a cadence gets honoured, since a
laptop is a poor place to keep a schedule.

Nothing about the Op changes — the same file runs either way. See
[`fountain-steward`](../fountain-steward/) for the declaration that puts one
there.
