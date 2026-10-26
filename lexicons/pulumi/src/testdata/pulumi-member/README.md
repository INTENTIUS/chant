# pulumi-member

`stack-export.json` is the stdout of `plunge stack export` after one real `plunge up` of the program in
`recording/` (project `app`, stack `dev`), recorded on 2026-10-26 for INTENTIUS/chant#4507. Nobody edits it by
hand; re-record it with the commands below.

- Tool: plunge v0.1.0-dev.0 (pulumi-compatible v3.272.0), built from INTENTIUS/plunge `integration/engine-ship` at
  d7653de7f5. The export's manifest says v3.272.0.
- Provider: pulumi-aws 7.51.1 (`@pulumi/aws` 7.51.1, `@pulumi/pulumi` 3.272.0; `recording/package-lock.json`).
- Emulator: floci, `ghcr.io/lex00/floci@sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec`
  (choudoufu `live/floci-image`), on localhost:4566. Nothing ran against AWS.
- Program: `recording/` at the chant commit that added this README. It is written for this fixture, not taken
  from the plunge corpus.

The program declares an S3 bucket `assets`, an IAM role `web`, an IAM role policy `webReadsAssets` that reads
both (its policy is a secret, so the export holds it as ciphertext), and a `my:mod:Web` component `web-app` whose
child is a Lambda function `handler` (floci serves Lambda) that depends on the role. The physical names carry
the prefix `rec-r2-4507`. The program is JavaScript so chant's tsc, which includes all of `src/`, never compiles it.

The hand-written export this replaces also had `webReadsAssets` depend on a bucket `elsewhere` that was not in
the export. A real export cannot say that, so `workspace-member.test.ts` builds that case from a copy of this file.

`Pulumi.yaml` beside the export (no backend URL, so the member's engine is pulumi) is what the tests read; the
recorded program's own `Pulumi.yaml` is in `recording/`.

## Commands

Run from `recording/`, with no real AWS, Azure, GCP or Pulumi Cloud credentials in the environment
(`<scratch>` is an empty scratch directory, `<plunge-dir>` holds the plunge binary and its language hosts):

```sh
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
export PULUMI_CONFIG_PASSPHRASE=plunge-baseline PULUMI_SKIP_UPDATE_CHECK=true
export PLUNGE_CLOUDCONTROL_ENDPOINT=http://localhost:4566
export PULUMI_BACKEND_URL=plunge+file://<scratch>
export PATH=<plunge-dir>:$PATH
npm ci
plunge stack init dev --secrets-provider passphrase
plunge up --yes --stack dev
plunge stack export --stack dev > ../stack-export.json
plunge destroy --yes --stack dev
```

`Pulumi.dev.yaml` points every AWS endpoint the program uses at localhost:4566 and skips the credential, account
and region checks. `PLUNGE_CLOUDCONTROL_ENDPOINT` points plunge's own Cloud Control listing at floci too; without
it plunge sends its marker listing to AWS's Cloud Control endpoint.

`plunge up` printed one warning: the sweep reported the Lambda function
(`arn:aws:lambda:us-east-1:000000000000:function:rec-r2-4507-handler`) as an unrecorded marked object, though the
stack records it under the id `rec-r2-4507-handler`.
