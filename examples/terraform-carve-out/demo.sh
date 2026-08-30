#!/usr/bin/env bash
set -euo pipefail

# Runnable, OFFLINE demo of the full Terraform carve-out flow. No cloud, no
# Terraform binary, no state backend — every step runs against the bundled
# terraform/ estate and terraform.tfstate.
#
# Steps: advise (what to carve) → emit (adopt into chant source from state) →
# audit (the build refuses the adopted posture) → bridge (patch the survivors)
# → apply (graduation plan). The real live steps (terraform state rm / apply)
# are printed, not executed.
#
# Requires: chant on PATH, @cdktf/hcl2json (npm install -D @cdktf/hcl2json).

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF="$HERE/terraform"
STATE="$TF/terraform.tfstate"
OUT="$HERE/carveout"
SELECT="aws_s3_bucket.assets"
CHANT="${CHANT:-chant}"

rule() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

rule "1. advise — what is cheap to carve"
$CHANT carve advise --from "$TF"

rule "2. emit — adopt $SELECT into chant source from tfstate (offline)"
$CHANT carve emit --from "$TF" --select "$SELECT" --state "$STATE" --output "$OUT"
echo "--- emitted chant source: $OUT/src/assets.ts ---"
cat "$OUT/src/assets.ts"

rule "3. audit — chant build refuses the adopted security posture"
if $CHANT build "$OUT/src" --lexicon aws >/dev/null 2>&1; then
  echo "unexpected: the adopted bucket built clean"
else
  $CHANT build "$OUT/src" --lexicon aws 2>&1 | grep 'error' || true
  echo "Expected: the adopted bucket faithfully lacks a public-access block and"
  echo "a TLS-only policy, so the audit blocks the build until you add them."
  echo "The tutorial shows the fix; the build then emits valid CloudFormation."
fi

rule "4. bridge — patch the surviving Terraform (target from the carve manifest)"
$CHANT carve bridge --from "$TF" --output "$OUT"
echo "--- generated data source ---"
cat "$OUT/aws_s3_bucket-assets-datasources.tf"

rule "5. apply — graduation plan (ownership marker + runbook; no cloud call)"
$CHANT carve apply --from "$TF" --output "$OUT" --env prod --stack assets

rule "done"
echo "Reviewed everything above without touching a cloud. The live steps"
echo "(terraform state rm / apply) are in the runbook at $OUT/${SELECT//./-}-runbook.md"
