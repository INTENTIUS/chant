#!/usr/bin/env bash
set -euo pipefail

# AWS config-controller round-trip E2E (#1208, epic #1198).
#
# The AWS lane's acceptance run: apply -> observe -> mutate-and-detect-drift ->
# reconcile -> rollback, on the canonical mixed-substrate example, against a
# local emulator, for $0.
#
# Where the other AWS e2e stops, this one starts. `components-aws-e2e.sh` proves
# synthesis and apply — a template becomes a real stack. This proves the whole
# CONTROLLER loop: that chant can then read that estate back, notice somebody
# changed it out of band, regenerate source from live, and compute the delta
# that would undo it. Each step below is a distinct claim, and each one failed
# for a different reason at some point in #1198; the assertions are written so a
# regression names which claim broke rather than "the e2e is red".
#
# Both substrates, one run. The cloud half is VPC/subnet/EC2/SG plus an EKS
# cluster; the k8s half is a Service on that cluster — a REAL one, since Floci
# k3s-backs EKS, reached through the cluster's own kubeconfig on a port the
# emulator allocates at creation (never a fixed one — behold#106).
#
# The round-trip runs in a throwaway git repo (a copy of the example), not in
# this checkout. Reconcile REWRITES source and rollback resolves `sourceDir`
# against the repo root, so running it here would both dirty the tree and
# resolve `src` to chant's own. The copy makes the rollback step meaningful:
# there is a real prior commit to roll back to.
#
# On-demand only — NOT part of gating CI. Needs Docker, the aws CLI and kubectl.
# Run it yourself:
#
#   just aws-cc-e2e     (or)   bash test/aws-cc-e2e.sh
#
# Override the emulator port with FLOCI_PORT (default 4598, chosen to clash with
# neither a Floci on 4566 nor components-aws-e2e's 4599).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / aws / kubectl); non-zero on
# a real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/cc-aws-canonical"
STACK="cc-canonical"
CLUSTER="cc-eks"
FLOCI_PORT="${FLOCI_PORT:-4598}"
FLOCI_NAME="chant-floci-cc-e2e-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
WORK="$(mktemp -d)"
KUBECONFIG_FILE="$WORK/kubeconfig"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"
command -v kubectl >/dev/null 2>&1 || skip "kubectl not installed"
[ -S /var/run/docker.sock ] || skip "no docker socket at /var/run/docker.sock (Floci starts the EKS k3s container through it)"

export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
export KUBECONFIG="$KUBECONFIG_FILE"
# The project under test lives outside this checkout (see the header), so `npx`
# cannot walk up to the repo's node_modules for the `tsx` the chant bin needs.
export PATH="$ROOT/node_modules/.bin:$PATH"

cleanup() {
  awsl eks delete-cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  awsl cloudformation delete-stack --stack-name "$STACK" >/dev/null 2>&1 || true
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  # Only the scratch dir: every build in this run writes into the throwaway
  # project copy, never into the example itself (whose template.json is tracked).
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 0. Boot Floci ────────────────────────────────────────────────────────────
# The docker socket is mounted because Floci starts a k3s container to back the
# EKS cluster. Without it the cluster reports FAILED with a socket error, which
# reads like an EKS gap and is not one.
echo "=== 0. Floci on :$FLOCI_PORT ==="
docker run -d --rm -p "${FLOCI_PORT}:4566" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name "$FLOCI_NAME" floci/floci:latest >/dev/null
for _ in $(seq 1 45); do
  curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' && break
  sleep 2
done
curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"eks"' \
  || fail "boot" "Floci did not come up with EKS enabled"

# The AWS lexicon's packaged registry (dist/meta.json) is what the live-import
# generator reads. It is a build artifact, absent from a fresh checkout, and
# without it the reconcile step below dies on a module-not-found that says
# nothing about reconcile.
echo "=== 0b. AWS lexicon bundle (dist/meta.json — the live-import generator reads it) ==="
npm --prefix "$ROOT/lexicons/aws" run bundle >/dev/null 2>&1 \
  || fail "bundle" "could not build the aws lexicon bundle"

# ── 1. The project under test: a throwaway git repo ──────────────────────────
echo "=== 1. Canonical example -> throwaway repo at $WORK/project ==="
mkdir -p "$WORK/project"
cp -R "$EXAMPLE/." "$WORK/project/"
rm -rf "$WORK/project/node_modules" "$WORK/project/template.json" "$WORK/project/k8s.yaml"
PROJECT="$WORK/project"
mkdir -p "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/aws" "$PROJECT/node_modules/@intentius/chant-lexicon-aws"
ln -sfn "$ROOT/lexicons/k8s" "$PROJECT/node_modules/@intentius/chant-lexicon-k8s"
cd "$PROJECT"
git init -q
git config user.email cc-e2e@example.com
git config user.name "cc e2e"
git add -A
git commit -qm "declared source, before the round-trip"
BASE_REF="$(git rev-parse --short HEAD)"
echo "  base revision $BASE_REF"

# ── 2. Synthesize both substrates ────────────────────────────────────────────
echo "=== 2. Synthesize ==="
chant build src --lexicon aws -o template.json >/dev/null
chant build src --lexicon k8s -o k8s.yaml >/dev/null
for kind in "AWS::EC2::VPC" "AWS::EC2::Subnet" "AWS::EC2::SecurityGroup" "AWS::EC2::Instance" "AWS::EKS::Cluster"; do
  grep -q "$kind" template.json || fail "synthesize" "template is missing $kind"
done
grep -q "kind: Service" k8s.yaml || fail "synthesize" "k8s output is missing the Service"
echo "  cloud half + k8s half synthesized"

# ── 3. APPLY (code -> cloud) ─────────────────────────────────────────────────
echo "=== 3. Apply — the component cfn-deploys the template ==="
chant run --components cc-canonical --env local --no-release-record >/dev/null
STATUS="$(awsl cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"
[ "$STATUS" = "CREATE_COMPLETE" ] || fail "apply" "stack status is '$STATUS', expected CREATE_COMPLETE"

# The EKS cluster is applied by the same template; wait for k3s behind it.
for _ in $(seq 1 60); do
  CS="$(awsl eks describe-cluster --name "$CLUSTER" --query 'cluster.status' --output text 2>/dev/null || echo PENDING)"
  [ "$CS" = "ACTIVE" ] && break
  [ "$CS" = "FAILED" ] && fail "apply" "EKS cluster reported FAILED"
  sleep 3
done
[ "$CS" = "ACTIVE" ] || fail "apply" "EKS cluster never became ACTIVE (last status: $CS)"

# The apiserver endpoint is allocated per cluster — read it, never assume it.
APISERVER="$(awsl eks describe-cluster --name "$CLUSTER" --query 'cluster.endpoint' --output text)"
echo "  stack $STATUS; EKS $CS on $APISERVER"

aws --endpoint-url "$ENDPOINT" eks update-kubeconfig --name "$CLUSTER" >/dev/null
# The k8s half is released the same way the cloud half was: by its component
# (#1495). cc-workload's kubectl-apply step stamps the field manager
# `chant:cc-aws-canonical` and prunes only within that marker — the release
# path and the ownership model are the same mechanism.
chant run --components cc-workload --env local --no-release-record >/dev/null \
  || fail "apply" "the cc-workload component could not kubectl-apply the k8s half"
kubectl get service cc-api -n default >/dev/null 2>&1 || fail "apply" "the Service is not on the cluster"
echo "  k8s half applied by the cc-workload component, through the cluster's own kubeconfig"

# ── 4. OBSERVE (both substrates, one read) ───────────────────────────────────
echo "=== 4. Observe — one --live read covering both substrates ==="
chant lifecycle diff local --live >"$WORK/observe.txt" 2>&1 || true
grep -qE "^\x1b\[1maws\x1b\[0m|^aws " "$WORK/observe.txt" || grep -q "aws" "$WORK/observe.txt" \
  || fail "observe" "no aws section in the live diff"
grep -q "k8s" "$WORK/observe.txt" || fail "observe" "no k8s section in the live diff — the cluster half was not observed"
grep -q "apiService" "$WORK/observe.txt" || fail "observe" "the k8s Service was not observed"
# A clean apply is quiet on the property axis: the security group is the one
# deep-readable type here (#1269), so it is the only resource that CAN report
# property drift, and it must not before anything is mutated.
grep -q "0 property drift" "$WORK/observe.txt" \
  || fail "observe" "a clean apply reported property drift (see $WORK/observe.txt)"
echo "  both substrates observed; clean apply is quiet"

# Both deploy units observed by their own lexicons (#1495): cc-canonical's
# cfn-deploy stack by aws's describeStackStatus, cc-workload's kubectl-apply
# unit by k8s's — which selects on the ownership labels the build stamped, so
# this line also proves the stamp survived the round trip.
chant components status local --live --json --no-release-record >"$WORK/components.json" 2>/dev/null \
  || fail "observe" "components status --live failed"
node -e '
  const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows;
  const want = { "cc-canonical": "cc-canonical", "cc-workload": "cc-aws-canonical" };
  for (const [name, stack] of Object.entries(want)) {
    const row = rows.find((r) => r.component === name);
    if (!row) { console.error("no status row for " + name); process.exit(1); }
    if (!row.live) { console.error(name + " is not live: " + JSON.stringify(row)); process.exit(1); }
    if (row.stack?.name !== stack) { console.error(name + " observed stack " + JSON.stringify(row.stack) + ", expected " + stack); process.exit(1); }
  }
' "$WORK/components.json" || fail "observe" "components status --live did not report both deploy units (see $WORK/components.json)"
echo "  components status --live reports both units: cfn stack + kubectl-apply stack"

# ── 5. MUTATE + DETECT DRIFT ─────────────────────────────────────────────────
# Out-of-band, exactly as a console edit would be. The security group is the
# deep-readable type, so this is the drift the lane can actually demonstrate.
echo "=== 5. Mutate out of band, then detect it ==="
SG_ID="$(awsl cloudformation describe-stack-resource --stack-name "$STACK" \
  --logical-resource-id appSecurityGroup \
  --query 'StackResourceDetail.PhysicalResourceId' --output text)"
awsl ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr 0.0.0.0/0 >/dev/null
chant lifecycle diff local --live >"$WORK/drift.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/drift.txt" || fail "drift" "the out-of-band rule was not reported as drift"
grep -q "appSecurityGroup" "$WORK/drift.txt" || fail "drift" "drift was reported but not attributed to appSecurityGroup"
grep -q "0.0.0.0/0" "$WORK/drift.txt" || fail "drift" "the added rule's CIDR is not named in the drift report"
echo "  somebody opening SSH to the world surfaced, named"

# ── 6. RECONCILE (cloud -> code) ─────────────────────────────────────────────
echo "=== 6. Reconcile — regenerate source from live ==="
chant import --from local --force >"$WORK/reconcile.txt" 2>&1 \
  || { cat "$WORK/reconcile.txt"; fail "reconcile" "live import failed"; }
# The generator writes NEW files (`other.ts`, `index.ts`) rather than editing the
# authored ones, so `git diff` alone sees nothing — `status` catches untracked.
[ -n "$(git status --porcelain -- src)" ] \
  || fail "reconcile" "import changed nothing — the drifted rule did not reach source"
grep -rq "0.0.0.0/0" src/ || fail "reconcile" "regenerated source does not carry the out-of-band rule"
for name in vpc appSecurityGroup appInstance privateSubnet igw; do
  grep -rq "$name" src/ || fail "reconcile" "regenerated source lost $name"
done
echo "  live reality is back in TypeScript, drift included"

# ── 7. ROLLBACK (git-source) ─────────────────────────────────────────────────
# The delta that would undo the reconcile. `--dry-run` because a rollback PR
# needs a GitHub remote and `gh`, and this run has neither by design.
echo "=== 7. Rollback — the delta back to the declared source ==="
git add -A
git commit -qm "reconciled from live (includes the out-of-band rule)"
chant lifecycle rollback local --to "$BASE_REF" --dry-run >"$WORK/rollback.diff" 2>"$WORK/rollback.err" \
  || { cat "$WORK/rollback.err"; fail "rollback" "rollback --dry-run failed"; }
[ -s "$WORK/rollback.diff" ] || fail "rollback" "rollback produced an empty delta"
grep -q "^-.*0\.0\.0\.0/0" "$WORK/rollback.diff" \
  || fail "rollback" "the rollback delta does not remove the out-of-band rule"
git rev-parse --verify "chant/rollback-local-$BASE_REF" >/dev/null 2>&1 \
  && fail "rollback" "--dry-run left a branch behind"
echo "  delta removes the drifted rule; nothing pushed, no branch left"

echo
echo "PASS: apply -> observe -> drift -> reconcile -> rollback, both substrates, on Floci."
echo "  cloud half : VPC/subnet/EC2/SG + EKS on $ENDPOINT"
echo "  k8s half   : Service on $CLUSTER via $APISERVER"
