#!/usr/bin/env bash
set -euo pipefail

# The "From zero to a promoted release" tutorial (#4168 step 6), driven end to
# end against a local AWS emulator (Floci): examples/trunk-curated-floci in a
# throwaway repository with a local bare remote, made a workspace with chant
# workspace init and set up with chant ci init, then a green commit, a release
# cut from it with --at, staging deployed from the release behind its gate, and
# the release promoted to prod behind prod's gate.
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
export GIT_AUTHOR_NAME=tutorial GIT_AUTHOR_EMAIL=tutorial@example.invalid GIT_COMMITTER_NAME=tutorial GIT_COMMITTER_EMAIL=tutorial@example.invalid
git init -q -b main
mkdir -p node_modules/@intentius
ln -sfn "$ROOT/packages/core" node_modules/@intentius/chant
ln -sfn "$ROOT/lexicons/aws" node_modules/@intentius/chant-lexicon-aws
ln -sfn "$ROOT/lexicons/github" node_modules/@intentius/chant-lexicon-github
printf 'node_modules/\n' >> .gitignore
git add -A
git commit -q -m "the stack"
git remote add origin "$WORK/origin.git"
git push -q origin main

echo "=== A workspace on the trunk-curated workflow ==="
"$CHANT" workspace init --yes
"$CHANT" ci init --workflow trunk-curated --forge github --yes
grep -q '"workflow": "trunk-curated"' chant.workspace.json || { echo "ci init wrote no ci.workflow"; exit 1; }
[ -f .github/workflows/chant-release.yml ] || { echo "ci init wrote no publish workflow"; exit 1; }
"$CHANT" workspace check --format json > "$WORK/check.json" || true
grep -q 'ci-workflow-pipeline-missing' "$WORK/check.json" || { echo "expected WSP151 to report the tick this repository has no CI for"; exit 1; }
git add -A
git commit -q -m "set up trunk-curated with chant ci init"
git push -q origin main

echo "=== A green commit ==="
SHA="$(git rev-parse HEAD)"
git tag -a "ci/green/$SHA" -m "green, by hand: this repository has no CI"
git push -q origin "ci/green/$SHA"

echo "=== Cut v0.1.0 from it ==="
"$CHANT" release cut v0.1.0 --at "$SHA" --build "$CHANT build src --lexicon aws -o template.json" --yes

stack_created() {
  STATUS="$(awsl cloudformation describe-stacks --stack-name "trunk-curated-$1" --query 'Stacks[0].StackStatus' --output text)"
  [ "$STATUS" = "CREATE_COMPLETE" ] || { echo "stack trunk-curated-$1 is '$STATUS', expected CREATE_COMPLETE"; exit 1; }
}

echo "=== Deploy staging from the release, behind its gate ==="
"$CHANT" release export v0.1.0 --env staging
"$CHANT" run --components all --env staging --release v0.1.0 2>&1 | tee "$WORK/run-staging.log" || true
grep -q 'gated on "release"' "$WORK/run-staging.log" || { echo "the first run in staging should stop at the gate"; exit 1; }
"$CHANT" approve infra release --env staging
"$CHANT" run --components all --env staging --release v0.1.0 2>&1 | tee "$WORK/run-staging-2.log"
# #4222: the template-only component is recorded under the release, so promote can read what staging runs.
grep -q 'Recorded release: .*infra.*@staging' "$WORK/run-staging-2.log" || { echo "the staging run recorded no release for infra"; exit 1; }
stack_created staging

echo "=== Promote it to prod, behind prod's gate ==="
"$CHANT" components promote --to prod --release v0.1.0 2>&1 | tee "$WORK/promote.log" && { echo "the first promote should stop at prod's gate"; exit 1; }
APPROVE="$(sed 's/\x1b\[[0-9;]*m//g' "$WORK/promote.log" | grep -o 'chant approve .*' | head -1)"
[ -n "$APPROVE" ] || { echo "the promote printed no approve line"; exit 1; }
"$CHANT" ${APPROVE#chant }
"$CHANT" components promote --to prod --release v0.1.0
stack_created prod

echo "PASS: v0.1.0, cut from a green commit, runs in staging and was promoted to prod, each behind its gate."
