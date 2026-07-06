#!/usr/bin/env bash
set -euo pipefail

# adopt-alb-services runtime E2E: prove the GENERATED one-pipeline setup deploys
# a multi-service, cross-stack app across ISOLATED jobs.
#
# The component release model's generate mode turns the three components
# (shared-alb + api + ui) into a thin `.gitlab-ci.yml`: one job per component,
# ordered by `dependsOn`. Each job is a separate `chant run --components <name>`
# process, so a service's `stackOutput("shared-alb", ...)` reference can't read
# shared-alb's outputs from memory — shared-alb ran in a different job. The fix
# (this is what the harness proves) is output threading as CI artifacts:
# shared-alb `--dump-outputs` a file GitLab passes across the `needs:` edge, and
# api/ui `--seed-outputs` it.
#
# This harness runs the ACTUAL generated pipeline's job commands, in wave order,
# as separate processes (the dumped file persists in the workspace, standing in
# for GitLab's artifact passing), against a local AWS emulator (Floci), then
# asserts all three stacks really landed. It is the runtime counterpart to the
# unit tests (which mock the executor) and the generate-mode tests (which assert
# the YAML). It combines the generate-mode + Floci-deploy stories.
#
# Floci >= 1.5.30 with the docker socket mounted is required: Floci starts a real
# backing container for the ECR registry, so it needs docker access, and the
# outputs fix landed in 1.5.30.
#
# On-demand only — NOT gating CI. Needs Docker + the aws CLI. Run it yourself:
#
#   just adopt-alb-services-e2e   (or)   bash test/adopt-alb-services-e2e.sh
#
# Override the emulator port with FLOCI_PORT (default 4599).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / no aws CLI); non-zero on a
# real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/adopt-alb-services"
FLOCI_PORT="${FLOCI_PORT:-4599}"
FLOCI_NAME="chant-floci-adopt-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
STACKS=(shared-alb api ui)

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
  for s in "${STACKS[@]}"; do awsl cloudformation delete-stack --stack-name "$s" >/dev/null 2>&1 || true; done
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  docker ps -aq --filter "name=floci" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$EXAMPLE/dist" "$EXAMPLE"/*.outputs.json "$EXAMPLE/.chant" "$BIN"
}
trap cleanup EXIT

# ── 1. Boot Floci (docker socket for the ECR backing registry) ───────────────
echo "=== Starting Floci 1.5.30 on :$FLOCI_PORT (docker socket mounted) ==="
docker run -d --rm -p "${FLOCI_PORT}:4566" -v /var/run/docker.sock:/var/run/docker.sock --name "$FLOCI_NAME" floci/floci:1.5.30 >/dev/null
for _ in $(seq 1 30); do curl -fs "${ENDPOINT}/" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "${ENDPOINT}/" >/dev/null 2>&1 || { echo "FAIL: Floci did not become ready"; exit 1; }

cd "$EXAMPLE"

# ── 2. Synthesize the IaC templates the components apply ─────────────────────
echo "=== chant build (aws lexicon → dist/*.template.json) ==="
for s in "${STACKS[@]}"; do chant build "src/$s" --lexicon aws -o "dist/$s.template.json" >/dev/null; done

# ── 3. Generate the thin pipeline from the components ────────────────────────
echo "=== chant build --components --generate gitlab → .gitlab-ci.generated.yml ==="
chant build --components --generate gitlab -o .gitlab-ci.generated.yml >/dev/null
echo "--- generated pipeline ---"; cat .gitlab-ci.generated.yml; echo "--------------------------"

# ── 4. Run the generated pipeline's jobs, in order, as isolated processes ────
# Extract each job's `chant run ...` command in the order the generator emits
# them (wave-1 before wave-2). Running them serially in the same workspace makes
# the `--dump-outputs` file from shared-alb available to api/ui's `--seed-outputs`
# — exactly what GitLab does by passing the artifact across the `needs:` edge.
echo "=== Executing the generated pipeline (each job an isolated 'chant run') ==="
JOBS_FILE="$(mktemp)"
grep -E '^[[:space:]]+- chant run ' .gitlab-ci.generated.yml | sed -E 's/^[[:space:]]+- //' > "$JOBS_FILE"
NJOBS="$(grep -c . "$JOBS_FILE")"
[ "$NJOBS" -eq 3 ] || { echo "FAIL: expected 3 pipeline jobs, got $NJOBS"; exit 1; }
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  echo "--- job: $cmd ---"
  eval "$cmd" 2>&1 | grep -E '✓|✗|completed|failed|error|required' | head -8
done < "$JOBS_FILE"

# ── 5. Assert all three stacks really deployed ───────────────────────────────
echo "=== Asserting all three stacks deployed on Floci ==="
fail=0
for s in "${STACKS[@]}"; do
  st="$(awsl cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
  echo "  $s: $st"
  case "$st" in CREATE_COMPLETE|UPDATE_COMPLETE) ;; *) fail=1 ;; esac
done
[ "$fail" -eq 0 ] || { echo "FAIL: not every stack reached a successful terminal status"; exit 1; }

echo "PASS: the generated one-pipeline setup deployed shared-alb + api + ui across isolated jobs (cross-stack outputs threaded as artifacts)"
