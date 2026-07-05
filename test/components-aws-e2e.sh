#!/usr/bin/env bash
set -euo pipefail

# Components AWS runtime E2E: synthesize IaC and ACTUALLY DEPLOY it with the
# component release model, against a local AWS emulator (Floci).
#
# Unlike the unit tests (which mock the CloudExecutor) and the post-synth checks
# (which prove the template is well-formed), this proves the full chant story
# executes: the AWS lexicon synthesizes a CloudFormation template, and a
# `*.component.ts` `cfn-deploy`s exactly that template — create-change-set,
# execute, wait — producing a real stack with real resources. It exercises the
# AWS_ENDPOINT_URL endpoint config and the create-vs-update change-set logic.
#
# Floci (https://floci.io) is a fast, free AWS emulator; chant's cfn-deploy is
# pointed at it by one env var, no wrapper. This is Floci's home in chant: a
# runtime-E2E harness, not a lexicon — the emulator speaks standard AWS APIs, so
# the synthesized template and the apply are identical against real AWS.
#
# On-demand only — NOT part of the gating CI. Needs Docker + the aws CLI, and is
# slower/flakier than unit tests. Run it yourself:
#
#   just components-aws-e2e     (or)   bash test/components-aws-e2e.sh
#
# Override the emulator port with FLOCI_PORT (default 4599, chosen to not clash
# with a LocalStack/Floci already on 4566).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / no aws CLI); non-zero on a
# real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/components-aws-e2e"
STACK="components-aws-e2e"
FLOCI_PORT="${FLOCI_PORT:-4599}"
FLOCI_NAME="chant-floci-e2e-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"

skip() { echo "SKIP: $1"; exit 0; }
awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"

export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

cleanup() {
  awsl cloudformation delete-stack --stack-name "$STACK" >/dev/null 2>&1 || true
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$EXAMPLE/node_modules" "$EXAMPLE/template.json"
}
trap cleanup EXIT

# ── 1. Boot Floci ─────────────────────────────────────────────────────────────
echo "=== Starting Floci on :$FLOCI_PORT ==="
docker run -d --rm -p "${FLOCI_PORT}:4566" --name "$FLOCI_NAME" floci/floci:latest >/dev/null
for _ in $(seq 1 30); do
  if curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"'; then break; fi
  sleep 2
done
curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' || { echo "Floci did not become ready"; exit 1; }

# ── 2. Link the workspace packages into the example ──────────────────────────
mkdir -p "$EXAMPLE/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$EXAMPLE/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/aws" "$EXAMPLE/node_modules/@intentius/chant-lexicon-aws"

cd "$EXAMPLE"

# ── 3. Synthesize the IaC (AWS lexicon → template.json) ──────────────────────
echo "=== chant build (synthesize CloudFormation) ==="
"$ROOT/packages/core/bin/chant" build src --lexicon aws -o template.json
grep -q "AWS::S3::Bucket" template.json && grep -q "AWS::SQS::Queue" template.json \
  || { echo "synthesized template missing expected resources"; exit 1; }

# ── 4. Deploy it via the component (cfn-deploy → Floci) ──────────────────────
echo "=== chant run --components (deploy the template) ==="
"$ROOT/packages/core/bin/chant" run --components demo-infra --env local --no-release-record

# ── 5. Assert the stack + resources really exist ─────────────────────────────
echo "=== Verifying live state in Floci ==="
STATUS="$(awsl cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"
[ "$STATUS" = "CREATE_COMPLETE" ] || { echo "stack status is '$STATUS', expected CREATE_COMPLETE"; exit 1; }
awsl s3api list-buckets --query 'Buckets[].Name' --output text | grep -q "${STACK}-" || { echo "expected S3 bucket not found"; exit 1; }
awsl sqs list-queues --query 'QueueUrls' --output text | grep -q "components-e2e-tasks" || { echo "expected SQS queue not found"; exit 1; }

echo "PASS: synthesized CloudFormation deployed via the component release model; stack $STATUS with its bucket + queue live."
