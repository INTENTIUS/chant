#!/usr/bin/env bash
set -euo pipefail

# chant#4461, the maintainer's run: `chant workspace promote --all` adopts a
# workspace of four plain Terraform roots into choudoufu against a local AWS
# emulator (Floci), canary first, one gate per root.
#
# Each root (logs, media, jobs, events) holds one S3 bucket and one SQS queue,
# created here with stock OpenTofu so each has a local version 4 tfstate. The
# states live outside the repository in a state directory. Then, with
# --canary logs --wave-size 2, so the waves are [logs], [media, jobs],
# [events]:
#
#   1. a dry run stages and checks every root and records no gate;
#   2. the first run gates the canary and runs no other wave;
#   3. the canary is approved and the run repeated: the canary is applied and
#      stamped, and wave 2 is gated;
#   4. wave 2 is approved and the run repeated, then wave 3 the same way;
#   5. a last run over the landed workspace is a no-op that records no gate.
#
# Every summary is kept under $OUT as the --json document the command printed.
# At the end the gate ledger on chant/lifecycle must hold one
# workspace-promote gate per root, each naming that root's live-import report
# digest from the summary, and every bucket and queue must carry the
# tofu-estate marker of its own root.
#
# On-demand only, never part of a gate. Needs Docker, the aws CLI, node,
# OpenTofu (`tofu`, or TOFU_BIN) and a choudoufu binary on PATH (or
# CHOUDOUFU_BIN). Nothing here talks to a real cloud: the provider and the
# aws CLI point at the emulator, with test credentials.
#
#   just workspace-promote-waves-floci-e2e   (or)   bash test/workspace-promote-waves-floci-e2e.sh
#
# FLOCI_PORT overrides the emulator's port (default 4596, clear of 4566, of
# trunk-curated-floci-e2e's 4597 and of components-aws-e2e's 4599).
# FLOCI_IMAGE overrides the image (default floci/floci:latest; choudoufu pins
# its own in live/floci-image). OUT is where the summaries go (default a new
# directory under $TMPDIR, printed at the end). KEEP=1 keeps the throwaway
# repository and the emulator for a look afterwards.
#
# Exit codes: 0 pass or cleanly skipped (a tool missing); non-zero on a real
# failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANT="$ROOT/packages/core/bin/chant"
CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
TOFU="${TOFU_BIN:-tofu}"
FLOCI_PORT="${FLOCI_PORT:-4596}"
FLOCI_IMAGE="${FLOCI_IMAGE:-floci/floci:latest}"
FLOCI_NAME="chant-promote-waves-e2e-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/chant-promote-waves-XXXXXX")"
OUT="${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/chant-promote-waves-run-XXXXXX")}"
REPO="$WORK/repo"
STATES="$WORK/states"
MEMBERS=(logs media jobs events)

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL: $1" >&2; exit 1; }
awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"
command -v node >/dev/null 2>&1 || skip "node not installed"
command -v "$TOFU" >/dev/null 2>&1 || skip "OpenTofu ($TOFU) not installed; set TOFU_BIN"
command -v "$CHOUDOUFU" >/dev/null 2>&1 || skip "choudoufu ($CHOUDOUFU) not on PATH; set CHOUDOUFU_BIN"

# promote runs `choudoufu ...` by name, so the binary it finds first on PATH is the one under test.
CHOUDOUFU_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chant-promote-waves-bin-XXXXXX")"
ln -s "$(command -v "$CHOUDOUFU")" "$CHOUDOUFU_DIR/choudoufu"
export PATH="$CHOUDOUFU_DIR:$ROOT/node_modules/.bin:$PATH"
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
# One provider download for every root and every staging worktree.
export TF_PLUGIN_CACHE_DIR="$WORK/plugin-cache"
mkdir -p "$TF_PLUGIN_CACHE_DIR" "$STATES" "$OUT"
APPROVER="${APPROVER:-${USER:-maintainer}}"

cleanup() {
  if [ "${KEEP:-}" = "1" ]; then
    echo "KEEP=1: the repository is $REPO, the emulator is $FLOCI_NAME on :$FLOCI_PORT"
    return
  fi
  docker rm -f -v "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK" "$CHOUDOUFU_DIR"
}
trap cleanup EXIT

echo "=== Versions ==="
"$CHOUDOUFU" version | head -1 | tee "$OUT/choudoufu-version.txt"
"$TOFU" version | head -1 | tee "$OUT/tofu-version.txt"
git -C "$ROOT" rev-parse HEAD | tee "$OUT/chant-commit.txt"

echo "=== Starting Floci ($FLOCI_IMAGE) on :$FLOCI_PORT ==="
docker run -d -p "${FLOCI_PORT}:4566" --name "$FLOCI_NAME" "$FLOCI_IMAGE" >/dev/null
docker inspect --format '{{.Image}}' "$FLOCI_NAME" | tee "$OUT/floci-image.txt"
for _ in $(seq 1 30); do
  if curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"s3"'; then break; fi
  sleep 2
done
curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"s3"' || fail "Floci did not become ready"

echo "=== Four plain Terraform roots, applied with stock OpenTofu ==="
mkdir -p "$REPO"
cd "$REPO"
export GIT_AUTHOR_NAME=maintainer GIT_AUTHOR_EMAIL=maintainer@example.invalid GIT_COMMITTER_NAME=maintainer GIT_COMMITTER_EMAIL=maintainer@example.invalid
git init -q -b main
printf '.terraform/\n*.tfstate\n*.tfstate.*\n.chant/\n' > .gitignore
for m in "${MEMBERS[@]}"; do
  mkdir -p "$m"
  cat > "$m/main.tf" <<EOF
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3  = "$ENDPOINT"
    sqs = "$ENDPOINT"
    sts = "$ENDPOINT"
  }
}

resource "aws_s3_bucket" "this" {
  bucket = "promote-waves-$m"
}

resource "aws_sqs_queue" "this" {
  name = "promote-waves-$m"
}
EOF
  (cd "$m" && "$TOFU" init -input=false -no-color >/dev/null && "$TOFU" apply -input=false -auto-approve -no-color >/dev/null)
  mv "$m/terraform.tfstate" "$STATES/$m.tfstate"
  rm -f "$m/terraform.tfstate.backup"
done
node -e 'const fs=require("fs");const names=process.argv.slice(1);fs.writeFileSync("chant.workspace.json",JSON.stringify({name:"promote-waves",schema:1,members:names.map((n)=>({name:n,dir:n,kind:"terraform"}))},null,2)+"\n")' "${MEMBERS[@]}"
git add -A
git commit -q -m "four plain Terraform roots"

kinds() { node -e 'const d=JSON.parse(require("fs").readFileSync("chant.workspace.json","utf8"));console.log(d.members.map((m)=>m.name+"="+m.kind).join(" "))'; }

# Run the promote; keep its summary and log, and check its exit code and each root's outcome.
#   promote <step name> <expected exit> <member>=<outcome>...
promote() {
  local step="$1" want="$2"
  shift 2
  echo "=== $step ==="
  set +e
  "$CHANT" workspace promote --all --state-dir "$STATES" --canary logs --wave-size 2 --json ${DRY:+--dry-run} >"$OUT/$step.json" 2>"$OUT/$step.log"
  local code=$?
  set -e
  sed 's/\x1b\[[0-9;]*m//g' "$OUT/$step.log"
  [ "$code" = "$want" ] || fail "$step exited $code, expected $want (see $OUT/$step.log)"
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const got = Object.fromEntries(s.roots.map((r) => [r.member, r.outcome]));
    for (const want of process.argv.slice(2)) {
      const [m, o] = want.split("=");
      if (got[m] !== o) { console.error(`${m} is ${got[m]}, expected ${o}`); process.exit(1); }
    }
    console.log(`waves ${JSON.stringify(s.waves)}; ${s.roots.map((r) => `${r.member} ${r.outcome}`).join(", ")}`);
  ' "$OUT/$step.json" "$@" || fail "$step: an outcome is not the expected one"
}
approve() { for m in "$@"; do "$CHANT" approve workspace-promote "$m" --actor "$APPROVER"; done; }

DRY=1 promote 00-dry-run 0 logs=dry-run media=dry-run jobs=dry-run events=dry-run
[ "$(kinds)" = "logs=terraform media=terraform jobs=terraform events=terraform" ] || fail "the dry run changed a kind"
[ -z "$(git status --porcelain)" ] || fail "the dry run touched the tree"

promote 01-canary-gated 3 logs=gated media=not-run jobs=not-run events=not-run
approve logs
promote 02-canary-applied 3 logs=applied media=gated jobs=gated events=not-run
[ "$(kinds)" = "logs=choudoufu media=terraform jobs=terraform events=terraform" ] || fail "after the canary: $(kinds)"
approve media jobs
promote 03-wave-2-applied 3 logs=already-promoted media=applied jobs=applied events=gated
approve events
promote 04-landed 0 logs=already-promoted media=already-promoted jobs=already-promoted events=applied
[ "$(kinds)" = "logs=choudoufu media=choudoufu jobs=choudoufu events=choudoufu" ] || fail "after the last wave: $(kinds)"
git add -A
git commit -q -m "adopt the workspace into choudoufu"

LEDGER_BEFORE="$(git rev-parse chant/lifecycle)"
promote 05-no-op 0 logs=already-promoted media=already-promoted jobs=already-promoted events=already-promoted
[ "$(git rev-parse chant/lifecycle)" = "$LEDGER_BEFORE" ] || fail "the no-op run wrote to the gate ledger"

echo "=== One workspace-promote gate per root, naming its report digest ==="
LEDGER_FILE="$(git ls-tree -r --name-only chant/lifecycle | grep 'workspace-promote\.jsonl$' | head -1)"
[ -n "$LEDGER_FILE" ] || fail "no workspace-promote gate ledger on chant/lifecycle"
git show "chant/lifecycle:$LEDGER_FILE" > "$OUT/workspace-promote-gates.jsonl"
node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const out = process.argv[2];
  // The digest each root was applied under, from the summary of the run that applied it.
  const applied = {};
  for (const f of ["02-canary-applied", "03-wave-2-applied", "04-landed"]) {
    for (const r of JSON.parse(fs.readFileSync(`${out}/${f}.json`, "utf8")).roots) if (r.outcome === "applied") applied[r.member] = r;
  }
  let bad = 0;
  for (const m of process.argv.slice(3)) {
    const row = applied[m];
    if (!row || !row.reportDigest || !row.digest) { console.error(`${m}: no applied row with a digest and a report digest`); bad++; continue; }
    const pending = lines.filter((l) => l.kind === "pending" && l.gate === m);
    const approvals = lines.filter((l) => l.kind !== "pending" && l.gate === m);
    const gates = [...new Set(pending.map((l) => l.planDigest))];
    if (gates.length !== 1 || gates[0] !== row.digest) { console.error(`${m}: pending gates bind ${JSON.stringify(gates)}, expected only ${row.digest}`); bad++; }
    if (!pending.every((l) => (l.description ?? "").includes(row.reportDigest))) { console.error(`${m}: a pending gate does not name report ${row.reportDigest}`); bad++; }
    if (!approvals.some((l) => l.planDigest === row.digest)) { console.error(`${m}: no approval of ${row.digest}`); bad++; }
    console.log(`${m}: gate workspace-promote/${m} binds ${row.digest}, report ${row.reportDigest}`);
  }
  process.exit(bad ? 1 : 0);
' "$OUT/workspace-promote-gates.jsonl" "$OUT" "${MEMBERS[@]}" || fail "the gate ledger does not hold one gate per root naming its report digest"

echo "=== Every bucket and queue carries its own root's estate marker ==="
for m in "${MEMBERS[@]}"; do
  awsl s3api get-bucket-tagging --bucket "promote-waves-$m" --output json > "$OUT/tags-bucket-$m.json"
  grep -q "\"tofu-estate\"" "$OUT/tags-bucket-$m.json" && grep -q "\"$m\"" "$OUT/tags-bucket-$m.json" || fail "bucket promote-waves-$m has no tofu-estate=$m marker"
  URL="$(awsl sqs get-queue-url --queue-name "promote-waves-$m" --query QueueUrl --output text)"
  awsl sqs list-queue-tags --queue-url "$URL" --output json > "$OUT/tags-queue-$m.json"
  grep -q "\"tofu-estate\": \"$m\"" "$OUT/tags-queue-$m.json" || fail "queue promote-waves-$m has no tofu-estate=$m marker"
  echo "$m: bucket and queue stamped"
done

echo "PASS: four roots adopted in waves [logs], [media, jobs], [events], one gate per root naming its report digest; the summaries are in $OUT"
