# components-aws-e2e — synthesis + release, end to end

The whole chant story in one example: the **AWS lexicon synthesizes** a
CloudFormation stack, and the **component release model deploys exactly that
template**. The IaC and the thing that ships it are the same artifact — no
drift, no second source of truth.

- `src/infra.ts` — the IaC: an S3 bucket + an SQS queue, authored as typed AWS
  resources. `chant build` synthesizes them to `template.json`.
- `infra.component.ts` — the release: a `Component` whose `deploy` composition is
  one `cfn-deploy` step pointed at `template.json`. `chant run --components` runs
  it; `cfn-deploy` drives CloudFormation (create-change-set → execute → wait), so
  when it returns the real stack exists.

## Run it against a local AWS emulator (Floci)

No AWS account needed. [Floci](https://floci.io) is a fast, free AWS emulator.
chant's `cfn-deploy` honors `AWS_ENDPOINT_URL`, so pointing it at Floci is one
env var — no wrapper, no shim.

```bash
# 1. start Floci (AWS on :4566)
docker run -d --rm -p 4566:4566 --name floci floci/floci:latest

# 2. point chant at it (throwaway creds are fine for a local emulator)
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

npm install
npm run build     # AWS lexicon → template.json  (the IaC)
npm run deploy    # component cfn-deploys template.json  (the release)
```

Confirm the stack and its resources really landed:

```bash
aws --endpoint-url $AWS_ENDPOINT_URL cloudformation describe-stacks --stack-name components-aws-e2e
aws --endpoint-url $AWS_ENDPOINT_URL s3api list-buckets
aws --endpoint-url $AWS_ENDPOINT_URL sqs list-queues
```

Tear down:

```bash
aws --endpoint-url $AWS_ENDPOINT_URL cloudformation delete-stack --stack-name components-aws-e2e
docker stop floci
```

## Run it against real AWS

Drop `AWS_ENDPOINT_URL` and use real credentials — nothing else changes:

```bash
unset AWS_ENDPOINT_URL
npm run build && npm run deploy
npm run teardown
```

The S3 bucket name folds in the account id (S3 names are globally unique); the
stack is two free-tier resources with no IAM.

## What this demonstrates

- **Semantic lint on the IaC.** The AWS lexicon blocks the build until the bucket
  blocks public access and the queue is encrypted — coherence, not just schema.
- **One artifact, two roles.** The template `cfn-deploy` applies is the exact one
  `chant build` synthesized. The release ships what synthesis produced.
- **Bring-your-own endpoint.** The component is identical against Floci and real
  AWS; only `AWS_ENDPOINT_URL` differs.
