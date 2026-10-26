# pulumi-refresh

Recorded on 2026-10-26 for INTENTIUS/chant#4475 against the plunge corpus at INTENTIUS/plunge 30806be26b (`tests/plunge-corpus/aws-ts`, corpus prefix `rec-ts`), stack `floci`, on the floci emulator (ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec) only, with file backends and fake credentials. Tools: stock pulumi v3.272.0 (darwin-arm64 release), plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0) built from the same plunge commit, provider pulumi-aws 7.51.1.

`stack-export.json` is the stack after its first `up`. Then, through floci's own API (`aws --endpoint-url http://localhost:4566`): the site bucket's `corpus-owner` tag set to `hotfix`, its bucket policy deleted, the `/rec-ts/db-password` SecureString overwritten (floci drops the parameter's tags when it is), and the events queue's `MessageRetentionPeriod` set to 600. Each file is `pulumi refresh --preview-only --json --stack floci --target <urn>`:

- `bucket-edited.json`: `aws:s3/bucket:Bucket::site-bucket`, op `update`.
- `role-same.json`: `aws:iam/role:Role::app-role`, untouched, op `refresh`.
- `policy-deleted.json`: `aws:s3/bucketPolicy:BucketPolicy::site-bucket-policy`, op `delete`.
- `secret-edited.json`: `aws:ssm/parameter:Parameter::db-password`, op `update`.
- `queue-edited.json`: `aws:sqs/queue:Queue::events`, op `update`.
- `all.json`: the same refresh untargeted.

A targeted refresh prints only its target's step. `PULUMI_SKIP_CONFIRMATIONS=true` makes the CLI refuse `--preview-only`.
