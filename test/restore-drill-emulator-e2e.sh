#!/usr/bin/env bash
set -euo pipefail

# Restore drill against a local AWS emulator (#5450).
#
# Runs a RestoreDrillOp end to end on Floci: an RDS instance and a snapshot of
# it are created, the drill restores the snapshot into a `drill-` scratch
# instance, checks it, tears it down, and records RTO and RPO on
# chant/lifecycle. A second run with an rto of one second must fail as missed
# and still tear down.
#
# Asserted:
#   1. Floci reports `rds` in /_localstack/health (otherwise the run stops
#      there: the emulator cannot host this drill).
#   2. First run exits 0; the newest line of emulator/drills.jsonl has
#      outcome passed, non-null rtoMs and rpoMs, tornDown true and every check ok.
#   3. No `drill-` instance is left in the emulator.
#   4. `chant workspace status --env emulator --json` lists the store with that drill.
#   5. Second run (rto "1s") exits non-zero; its record has outcome missed
#      with a shortfall.rtoMs, tornDown true, and again no `drill-` instance.
#
# On-demand only, started by a person: `just restore-drill-emulator-e2e`
# (it stops with exit 3 unless a person types `run`). Needs Docker, the aws CLI
# and node. Costs nothing: no real cloud is reached. Override the port with
# FLOCI_PORT (default 4602).
#
# The aws CLI sees only the emulator: every credential, profile and config
# variable is removed and shared config files point at nothing, then dummy
# keys and AWS_ENDPOINT_URL are set. If AWS_ENDPOINT_URL does not point at
# localhost the script refuses to go on.
#
# Exit codes: 0 pass or cleanly skipped (no Docker, no aws CLI); non-zero on a failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOCI_PORT="${FLOCI_PORT:-4602}"
FLOCI_NAME="chant-floci-restore-drill-e2e-$$"
FLOCI_IMAGE="floci/floci:1.5.34"
WORK="$(mktemp -d)"
PROJECT="$WORK/project"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"
command -v node >/dev/null 2>&1 || skip "node not installed"
[ -S /var/run/docker.sock ] || skip "no docker socket at /var/run/docker.sock (Floci starts each RDS instance's database container through it)"

# ── Keep real cloud credentials out ──────────────────────────────────────────
for v in $(env | sed -n 's/^\(AWS_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
export AWS_CONFIG_FILE="$WORK/no-aws-config" AWS_SHARED_CREDENTIALS_FILE="$WORK/no-aws-credentials"
export AWS_EC2_METADATA_DISABLED=true AWS_PAGER=""
export AWS_ENDPOINT_URL="http://localhost:${FLOCI_PORT}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
case "$AWS_ENDPOINT_URL" in http://localhost:*) ;; *) fail "safety" "AWS_ENDPOINT_URL is not local" ;; esac
export PATH="$ROOT/node_modules/.bin:$PATH"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@chant.dev GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@chant.dev

cleanup() {
  # Floci backs each RDS instance with a database container it starts through
  # the docker socket. Delete the instances first so none outlives the emulator.
  for id in $(aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text 2>/dev/null); do
    aws rds delete-db-instance --db-instance-identifier "$id" --skip-final-snapshot >/dev/null 2>&1 || true
  done
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 0. Boot Floci ────────────────────────────────────────────────────────────
echo "=== 0. Floci on :$FLOCI_PORT ==="
# The docker socket is mounted because Floci starts a real database container
# for each RDS instance. Without it create-db-instance fails with a socket error.
docker run -d --rm -p "127.0.0.1:${FLOCI_PORT}:4566" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name "$FLOCI_NAME" "$FLOCI_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fs "${AWS_ENDPOINT_URL}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' && break
  sleep 2
done
HEALTH="$(curl -fs "${AWS_ENDPOINT_URL}/_localstack/health" 2>/dev/null || true)"
[ -n "$HEALTH" ] || fail "boot" "Floci did not become ready"
echo "$HEALTH" | grep -q '"rds"' || fail "rds" "Floci's health lists no rds service, so it cannot host this drill: $HEALTH"

# ── 1. An instance and a snapshot of it ──────────────────────────────────────
echo "=== 1. RDS instance orders-emu and snapshot orders-snap ==="
aws rds create-db-instance --db-instance-identifier orders-emu --db-instance-class db.t3.micro \
  --engine postgres --master-username chant --master-user-password chant-emulator-1 --allocated-storage 20 >/dev/null \
  || fail "setup" "create-db-instance failed"
aws rds wait db-instance-available --db-instance-identifier orders-emu || fail "setup" "orders-emu never became available"
aws rds create-db-snapshot --db-instance-identifier orders-emu --db-snapshot-identifier orders-snap >/dev/null \
  || fail "setup" "create-db-snapshot failed"
aws rds wait db-snapshot-available --db-snapshot-identifier orders-snap || fail "setup" "orders-snap never became available"

# ── 2. The project: a git repo, a one-member workspace, two drill Ops ────────
echo "=== 2. Throwaway project at $PROJECT ==="
mkdir -p "$PROJECT/src" "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/aws" "$PROJECT/node_modules/@intentius/chant-lexicon-aws"
cat >"$PROJECT/chant.config.ts" <<'CFG'
export default { lexicons: ["aws"], sourceDir: "src" };
CFG
cat >"$PROJECT/chant.workspace.json" <<'WS'
{ "name": "drill-e2e", "schema": 1, "members": [{ "name": "app", "dir": ".", "kind": "other", "because": "the fixture" }] }
WS
drill_op() { # name rto
cat >"$PROJECT/src/$1.op.ts" <<OP
import { RestoreDrillOp } from "@intentius/chant/op";

export const { op } = RestoreDrillOp({
  name: "$1",
  env: "emulator",
  store: { kind: "rds", name: "orders", instance: "orders-emu" },
  checks: [{
    name: "restored-instance-available",
    kind: "command",
    cmd: 'aws rds describe-db-instances --db-instance-identifier "\$DRILL_SCRATCH" --query "DBInstances[0].DBInstanceStatus" --output text',
    expect: { equals: "available" },
  }],
  targets: { rto: "$2", rpo: "1h" },
});
OP
}
drill_op restore-drill-emulator 10m
drill_op restore-drill-emulator-miss 1s
cd "$PROJECT"
git init -q -b main && printf 'node_modules\n' >.gitignore && git add -A && git commit -q -m init

# last_record <file>: the newest line of emulator/drills.jsonl, written to <file>.
last_record() { git show chant/lifecycle:emulator/drills.jsonl | tail -1 >"$1"; }
# field <file> <js expression over r>
field() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(String(v))' "$1" "$2"; }
no_scratch_left() {
  local ids
  ids="$(aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' --output text)"
  case "$ids" in *drill-*) fail "$1" "a drill- instance is left in the emulator: $ids" ;; esac
}

# ── 3. The passing drill ─────────────────────────────────────────────────────
echo "=== 3. chant run restore-drill-emulator ==="
chant run restore-drill-emulator >"$WORK/run1.out" 2>&1 || { cat "$WORK/run1.out"; fail "run" "the drill exited non-zero"; }
last_record "$WORK/r1.json"
[ "$(field "$WORK/r1.json" 'r.outcome')" = passed ] || fail "record" "outcome is not passed: $(cat "$WORK/r1.json")"
[ "$(field "$WORK/r1.json" 'r.rtoMs !== null && r.rpoMs !== null')" = true ] || fail "record" "rtoMs or rpoMs is null"
[ "$(field "$WORK/r1.json" 'r.tornDown')" = true ] || fail "record" "tornDown is not true"
[ "$(field "$WORK/r1.json" 'r.checks.length > 0 && r.checks.every((c) => c.ok)')" = true ] || fail "record" "a check is not ok"
no_scratch_left "teardown"

# ── 4. workspace status shows the row ────────────────────────────────────────
echo "=== 4. chant workspace status ==="
chant workspace status --env emulator --json >"$WORK/status1.json" 2>"$WORK/status.err" || fail "status" "status failed: $(cat "$WORK/status.err")"
[ "$(field "$WORK/status1.json" 'r.members[0].drills.some((d) => d.store === "orders" && d.outcome === "passed" && d.rtoMs !== null)')" = true ] \
  || fail "status" "status lists no passed drill of orders: $(cat "$WORK/status1.json")"

# ── 5. The drill that must miss its target ───────────────────────────────────
echo "=== 5. chant run restore-drill-emulator-miss (rto 1s) ==="
if chant run restore-drill-emulator-miss >"$WORK/run2.out" 2>&1; then
  cat "$WORK/run2.out"; fail "miss" "the drill with rto 1s exited 0"
fi
last_record "$WORK/r2.json"
[ "$(field "$WORK/r2.json" 'r.outcome')" = missed ] || fail "miss" "outcome is not missed: $(cat "$WORK/r2.json")"
[ "$(field "$WORK/r2.json" 'typeof r.shortfall.rtoMs === "number" && r.shortfall.rtoMs > 0')" = true ] || fail "miss" "no shortfall.rtoMs"
[ "$(field "$WORK/r2.json" 'r.tornDown')" = true ] || fail "miss" "the missed drill did not tear down"
no_scratch_left "miss-teardown"

echo "PASS: drill passed with RTO and RPO recorded and torn down; status shows it; an rto of 1s was missed with a shortfall and still tore down."
