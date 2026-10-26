# Drift-record adapter fixtures (#4451)

Hand-written, in the shapes `drift-record.test.ts` reads:

- `live-diff.json`: a `LiveDiffResult` (`chant lifecycle diff --live --json`), one entity in every bucket.
- `deep-diff.json`: a `DeepDiffResult`, with a changed path, an absent path, a path whose name looks secret-bearing, and a deep hole on an entity the thin read found.
- `component-status.json`: a `ComponentStatusResult` (`chant components status prod --live --json`), one row per reconciliation verdict, plus an `unknown` row that was never queried live.

None of them was recorded from a run.

`choudoufu-resource.ndjson` and `choudoufu-cone.ndjson` are recorded (#4475, 2026-10-26): choudoufu
v0.31.1-local.c4f468a235, a build of INTENTIUS/choudoufu `integration/engine-ship` at c4f468a235, ran
choudoufu's own `live/e2e/estate-block` fixture (estate renamed `rec4475-block`) on the floci emulator
(`ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`) after an apply.
`choudoufu-resource.ndjson` is `live-plan -resource=aws_cloudwatch_log_group.app` after the log group's retention
was changed through floci's API; `choudoufu-cone.ndjson` is `live-plan -resource=aws_subnet.app`, whose cone holds
the VPC. What the recording showed beside the earlier hand-written stream: records carry no `resourceType`, a
drifted record names its paths with no values, neither the start nor the settle line has an `at`, and the settle's
`reads` adds `tagIndexCalls`.

The three JSON files above stay hand-written: recording them means a chant AWS project deployed through
CloudFormation on floci, read with `chant lifecycle diff --live --json`, its deep diff and
`chant components status <env> --live --json`, which is a run of its own (a follow-up on #4475).
