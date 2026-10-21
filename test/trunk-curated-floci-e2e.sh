#!/usr/bin/env bash
set -euo pipefail

# The "From zero to a promoted release" tutorial (#4168 step 6), driven end to
# end against a local AWS emulator (Floci): examples/trunk-curated-floci in a
# throwaway repository with a local bare remote, a green commit, a release cut
# from it with --at, and each environment deployed from the release behind its
# gate, staging then prod.
#
# The green tag is made by hand here, as the tutorial says, because the
# throwaway repository has no CI. Everything after it is what a person runs.
#
# On-demand only, not part of the gating CI. Needs Docker and the aws CLI:
#
#   just trunk-curated-floci-e2e     (or)   bash test/trunk-curated-floci-e2e.sh
#
# FLOCI_PORT overrides the emulator's port (default 4597, clear of the 4566 a
# Floci or LocalStack may already hold and of components-aws-e2e's 4599).
#
# Exit codes: 0 pass or cleanly skipped (no Docker or aws CLI); non-zero on a
# real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/trunk-curated-floci"
CHANT="$ROOT/packages/core/bin/chant"
FLOCI_PORT="${FLOCI_PORT:-4597}"
FLOCI_NAME="chant-trunk-curated-e2e-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/chant-trunk-curated-XXXXXX")"

skip() { echo "SKIP: $1"; exit 0; }
awsl() { aws --endpoint-url "$ENDPOINT" "$@"; }

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v aws >/dev/null 2>&1 || skip "aws CLI not installed"

export PATH="$ROOT/node_modules/.bin:$PATH"
export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1

cleanup() {
  # -v: the Floci image declares a data volume, which goes with the container.
  docker rm -f -v "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== Starting Floci on :$FLOCI_PORT ==="
docker run -d -p "${FLOCI_PORT}:4566" --name "$FLOCI_NAME" floci/floci:latest >/dev/null
for _ in $(seq 1 30); do
  if curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"'; then break; fi
  sleep 2
done
curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' || { echo "Floci did not become ready"; exit 1; }

echo "=== A repository with a remote ==="
git init -q --bare "$WORK/origin.git"
mkdir -p "$WORK/repo"
cp -R "$EXAMPLE/." "$WORK/repo/"
cd "$WORK/repo"
git init -q -b main
git add -A
git -c user.name=tutorial -c user.email=tutorial@example.invalid commit -q -m "the stack, as a trunk-curated workspace"
git remote add origin "$WORK/origin.git"
git push -q origin main
mkdir -p infra/node_modules/@intentius
ln -sfn "$ROOT/packages/core" infra/node_modules/@intentius/chant
ln -sfn "$ROOT/lexicons/aws" infra/node_modules/@intentius/chant-lexicon-aws
export GIT_AUTHOR_NAME=tutorial GIT_AUTHOR_EMAIL=tutorial@example.invalid GIT_COMMITTER_NAME=tutorial GIT_COMMITTER_EMAIL=tutorial@example.invalid

echo "=== The workspace check knows the workflow ==="
"$CHANT" workspace check --format json > "$WORK/check.json" || true
grep -q '"ruleId": *"WSP151"' "$WORK/check.json" || { echo "expected WSP151 findings for the pipelines the repository lacks"; exit 1; }

echo "=== A green commit ==="
SHA="$(git rev-parse HEAD)"
git tag -a "ci/green/$SHA" -m "green, by hand: this repository has no CI"
git push -q origin "ci/green/$SHA"

cd infra
echo "=== Cut v0.1.0 from it ==="
"$CHANT" release cut v0.1.0 --at "$SHA" --build "$CHANT build src --lexicon aws -o template.json" --yes

for ENV in staging prod; do
  echo "=== Deploy $ENV from the release, behind its gate ==="
  "$CHANT" release export v0.1.0 --env "$ENV"
  "$CHANT" run --components all --env "$ENV" --release v0.1.0 2>&1 | tee "$WORK/run-$ENV.log" || true
  grep -q 'gated on "release"' "$WORK/run-$ENV.log" || { echo "the first run in $ENV should stop at the gate"; exit 1; }
  "$CHANT" approve infra release --env "$ENV"
  "$CHANT" run --components all --env "$ENV" --release v0.1.0
  STATUS="$(awsl cloudformation describe-stacks --stack-name "trunk-curated-$ENV" --query 'Stacks[0].StackStatus' --output text)"
  [ "$STATUS" = "CREATE_COMPLETE" ] || { echo "stack trunk-curated-$ENV is '$STATUS', expected CREATE_COMPLETE"; exit 1; }
done

echo "PASS: v0.1.0, cut from a green commit, runs in staging and prod, each deployed behind its gate."
