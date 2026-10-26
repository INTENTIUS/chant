# Drift-record adapter fixtures (#4451)

Every fixture here is recorded from a run (#4475, 2026-10-26). None is hand-written.

## The chant reads

Recorded on the floci emulator (`ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`) with chant 0.124.34 from INTENTIUS/chant `integration/engine-ship` at
9ae806b69 plus this change, running from source. The project is a small chant AWS project (a bucket and its policy,
a queue, an IAM role tagged `api-token-owner`, two security groups and three topics) deployed with
`chant run --components` (cfn-deploy) into stack `recy`, plus four one-resource components (`api`, `jobs`, `edge`,
`docs`) on their own stacks. The sequence:

1. deploy `demo-infra`, `api` and `jobs` with release records, `edge` with `--no-release-record`, `docs` never;
2. `chant lifecycle snapshot recy --deep`;
3. add the two security groups and `alertsTopic` and deploy `demo-infra` again;
4. out of band through floci's API: delete stack `recy-jobs`, retag the role, delete the queue;
5. change the source without deploying: drop `strayTopic`, add `cacheTopic`, change `webSg`'s description;
6. read.

- `lifecycle-diff-live.json`: `chant lifecycle diff recy --live --json`, the whole document as `chant workspace
  drift` reads it. The one edit: the scratch project's absolute path in `reconcile[].sourceFile` is `<project>/`.
- `live-diff.json`: that document's `lexicons.aws.resources` (a `LiveDiffResult`), unchanged.
- `deep-diff.json`: its `lexicons.aws.deep` (a `DeepDiffResult`), unchanged.
- `component-status.json`: `chant components status recy --live --json`.
- `component-status-ledger.json`: `chant components status recy --json` (no `--live`).

What the recording showed beside the earlier hand-written files:

- `components status --json` prints a bare array of rows, not `{ env, rows, malformedLedgerLines }`.
  `chant workspace drift` already read it as an array; the test now does too.
- `LiveDiffResult` also carries `queried` and `definitions`.
- A redeploy since the snapshot shows as thin drift on `lastUpdated`, `status` and, for a bucket policy,
  `physicalId`. An entity dropped from the source while its stack still holds it reads as `disappeared`, not
  `orphan`: the stack carries no chant ownership marker, so the read looks only at declared names.
- floci's Cloud Control `GetResource` returns identity properties only, so most declared deep properties read
  `absent` (declared value, no live value). A source change after deploy gives a `changed` property
  (`webSg`'s `GroupDescription`). The deep read also lists the security groups under `unclaimed`.
- The deep read addresses keyed array elements by key (`Tags[#api-token-owner].Value`). The drift record did not
  read that form as a key, so a tag named like a token kept its value. `attributePathKeys` now reads `[#key]` as a
  key, and those paths redact.
- A queue deleted through SQS still reads as present: the read lists the stack's resources, and the stack still
  names it.

What floci cannot produce, kept as constructed inputs inside `drift-record.test.ts` (not as files): a runtime
child, an orphan, an unchanged thin entity, a thin attribute change beyond timestamps, a failed deep read, a deep
unchanged entity, a component whose live digest differs from its record, and missing credentials.

## The choudoufu stream

`choudoufu-resource.ndjson` and `choudoufu-cone.ndjson` are recorded (#4475, 2026-10-26): choudoufu
v0.31.1-local.c4f468a235, a build of INTENTIUS/choudoufu `integration/engine-ship` at c4f468a235, ran
choudoufu's own `live/e2e/estate-block` fixture (estate renamed `rec4475-block`) on the floci emulator
(`ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`) after an apply.
`choudoufu-resource.ndjson` is `live-plan -resource=aws_cloudwatch_log_group.app` after the log group's retention
was changed through floci's API; `choudoufu-cone.ndjson` is `live-plan -resource=aws_subnet.app`, whose cone holds
the VPC. What the recording showed beside the earlier hand-written stream: records carry no `resourceType`, a
drifted record names its paths with no values, neither the start nor the settle line has an `at`, and the settle's
`reads` adds `tagIndexCalls`.
