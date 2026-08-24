# local-op-quickstart

The smallest possible Op — runs in-process with **no Temporal server, Docker, or cloud**.

```bash
npm install
chant run hello
```

```
[phase] Greet
  ✓ shellCmd(cmd=echo hello from chant)   42ms
Op "hello" completed in 0.1s
```

`chant run` executes Ops locally by default: phased, with per-step retries and
`onFailure` compensation. Machine-readable output:

```bash
chant run hello --json
```

## A gated one-shot migration (effect receipt)

`local-aws-migrate` extends the local-aws loop with a migration that must run
exactly once per input set. The `effect(schemaSeeded, [...])` step reads the
receipt — an `AWS::SSM::Parameter` at
`/chant-receipts/local-op-quickstart/local/demo-schema-seed`, path derived
from `ownership` in `chant.config.ts` — and skips the gated migration when it
already matches. On a mismatch the gate pauses for approval, the migration
runs, and the receipt is written only after success. The gate needs
`--temporal`:

```bash
chant run local-aws-migrate --temporal --env local
chant run signal local-aws-migrate approve-migration
```

The receipt is plain infrastructure: `aws ssm get-parameter --name
/chant-receipts/local-op-quickstart/local/demo-schema-seed` reads it with
read-only IAM and no chant binary.

## Graduating to Temporal

Local mode covers dev loops, CI, and drift/observation Ops. For durable resume
after a crash, human **gates**, and **schedules**, configure a Temporal profile
in `chant.config.ts` and run with `--temporal`:

```bash
chant run hello --temporal
```

See [Local vs Temporal](https://intentius.dev/chant/guide/local-vs-temporal/) for
the full trade-off.
