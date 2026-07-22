#!/usr/bin/env bash
set -euo pipefail

# carve emit runtime E2E: prove `chant carve emit --env` adopts a LIVE AWS
# resource into typed chant source, against a real AWS endpoint (Floci).
#
# The offline path (`carve emit --state`) is unit-tested with real tfstate data.
# This harness covers the live cloud→code path: it deploys a CloudFormation
# stack containing an S3 bucket to Floci, then runs `carve emit --env <stack>`
# and asserts real chant source is generated from the live export.
#
# Note on scope: a genuinely Terraform-managed resource is not in a
# CloudFormation stack, so the live path fits resources already CFN-managed;
# for a pure-Terraform carve, use `--state`. This harness proves the live-import
# mechanism works end to end against a real endpoint.
#
# On-demand only — NOT gating CI. Needs Docker + the aws CLI. Run it yourself:
#
#   just carve-emit-e2e   (or)   bash test/carve-emit-e2e.sh
#
# Override the emulator port with FLOCI_PORT (default 4601).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / no aws CLI); non-zero on a
# real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOCI_PORT="${FLOCI_PORT:-4601}"
FLOCI_NAME="chant-floci-carve-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
STACK="carvedemo"
BUCKET="carve-demo-bucket-$$"
WORK="$(mktemp -d)"

skip() { echo "SKIP: $1"; exit 0; }
awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"

BIN="$(mktemp -d)"; ln -sf "$ROOT/packages/core/bin/chant" "$BIN/chant"
export PATH="$BIN:$PATH"
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1

cleanup() {
  awsl cloudformation delete-stack --stack-name "$STACK" >/dev/null 2>&1 || true
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$BIN"
}
trap cleanup EXIT

# ── 1. Boot Floci ────────────────────────────────────────────────────────────
echo "=== Starting Floci on :$FLOCI_PORT ==="
docker run -d --rm -p "${FLOCI_PORT}:4566" --name "$FLOCI_NAME" floci/floci:1.5.30 >/dev/null
for _ in $(seq 1 30); do curl -fs "${ENDPOINT}/" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "${ENDPOINT}/" >/dev/null 2>&1 || { echo "FAIL: Floci did not become ready"; exit 1; }

# ── 2. Deploy a CloudFormation stack with an S3 bucket ───────────────────────
echo "=== Deploying stack '$STACK' (one S3 bucket) to Floci ==="
cat > "$WORK/template.json" <<JSON
{
  "AWSTemplateFormatVersion": "2010-09-09",
  "Resources": {
    "AssetsBucket": {
      "Type": "AWS::S3::Bucket",
      "Properties": { "BucketName": "$BUCKET" }
    }
  }
}
JSON
awsl cloudformation deploy --template-file "$WORK/template.json" --stack-name "$STACK" >/dev/null
ST="$(awsl cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
case "$ST" in CREATE_COMPLETE|UPDATE_COMPLETE) echo "  stack: $ST" ;; *) echo "FAIL: stack did not deploy ($ST)"; exit 1 ;; esac

# ── 3. A minimal Terraform estate naming the same resource ───────────────────
mkdir -p "$WORK/tf"
cat > "$WORK/tf/main.tf" <<TF
resource "aws_s3_bucket" "assets" {
  bucket = "$BUCKET"
}
TF

# ── 4. carve emit --env: adopt the LIVE bucket into chant source ─────────────
echo "=== chant carve emit --env $STACK (live cloud→code against Floci) ==="
OUT="$WORK/carveout"
chant carve emit --from "$WORK/tf" --select aws_s3_bucket.assets --env "$STACK" --output "$OUT" 2>&1 | tail -6

# ── 5. Assert real chant source was generated from the live export ───────────
echo "=== Asserting emitted chant source ==="
EMITTED="$(find "$OUT" -name '*.ts' 2>/dev/null | head -1)"
if [ -z "$EMITTED" ]; then
  echo "FAIL: carve emit produced no TypeScript source"
  find "$OUT" -type f 2>/dev/null || true
  exit 1
fi
echo "  emitted: $EMITTED"
if grep -q "Bucket" "$EMITTED" && grep -q "$BUCKET" "$EMITTED"; then
  echo "PASS: carve emit adopted the live S3 bucket ($BUCKET) into chant source"
else
  echo "FAIL: emitted source did not reference the adopted bucket"
  echo "--- emitted ---"; cat "$EMITTED"
  exit 1
fi
