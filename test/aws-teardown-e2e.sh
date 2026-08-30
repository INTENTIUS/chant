#!/usr/bin/env bash
set -euo pipefail

# AWS stack-level env teardown E2E (#1222, PR 4).
#
# The acceptance run for `chant lifecycle teardown <env>` against aws: deploy
# TWO environments of the same project plus one foreign stack, tear ONE env
# down, and prove that exactly that env's stack is gone — the other env's
# stack and the foreign stack untouched.
#
# What this exercises end to end, against a local emulator, for $0:
#   - the build stamps the ownership marker into the template
#     (`Metadata["chant:ownership"]`), env taken from `--param env=...`;
#   - the native applier (`awsApply`) turns that block into the STACK's own
#     tags on CreateStack — the identity teardown verifies;
#   - `chant lifecycle teardown dev` plans exactly the env's marker-verified
#     stack, and `--yes` DeleteStacks it to DELETE_COMPLETE;
#   - a stack carrying no chant marker is never deleted, whatever happens.
#
# On-demand only — NOT part of gating CI. Needs Docker. Run it yourself:
#
#   just aws-teardown-e2e     (or)   bash test/aws-teardown-e2e.sh
#
# Override the emulator port with FLOCI_PORT (default 4601, clashing with
# neither a Floci on 4566 nor the other aws e2e runs on 4598/4599).
#
# Exit codes: 0 pass or cleanly skipped (no Docker); non-zero on a real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLOCI_PORT="${FLOCI_PORT:-4601}"
FLOCI_NAME="chant-floci-teardown-e2e-$$"
ENDPOINT="http://localhost:${FLOCI_PORT}"
WORK="$(mktemp -d)"
PROJECT="$WORK/project"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }
cfn() { curl -s -X POST "$ENDPOINT/" -d "$1"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

export AWS_ENDPOINT_URL="$ENDPOINT"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
# The project under test lives outside this checkout, so `npx` cannot walk up
# to the repo's node_modules for the `tsx` the chant bin needs.
export PATH="$ROOT/node_modules/.bin:$PATH"

cleanup() {
  docker rm -f "$FLOCI_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 0. Boot Floci ────────────────────────────────────────────────────────────
echo "=== 0. Floci on :$FLOCI_PORT ==="
docker run -d --rm -p "${FLOCI_PORT}:4566" --name "$FLOCI_NAME" floci/floci:latest >/dev/null
for _ in $(seq 1 30); do
  curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' && break
  sleep 2
done
curl -fs "${ENDPOINT}/_localstack/health" 2>/dev/null | grep -q '"cloudformation"' \
  || fail "boot" "Floci did not become ready"

# ── 1. The project under test: two declared envs, marker env bound to a param ─
echo "=== 1. Throwaway project at $PROJECT ==="
mkdir -p "$PROJECT/src" "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/aws" "$PROJECT/node_modules/@intentius/chant-lexicon-aws"

cat >"$PROJECT/chant.config.ts" <<'EOF'
export default {
  lexicons: ["aws"],
  sourceDir: "src",
  environments: [{ name: "dev" }, { name: "staging" }],
  // The marker identity teardown selects on. `env` references the build
  // parameter so `--param env=dev` and the stamped marker cannot drift apart.
  ownership: { stack: "teardown-e2e", env: { param: "env" } },
  buildParams: { env: { type: "string", enum: ["dev", "staging"], required: true } },
};
EOF

cat >"$PROJECT/src/infra.ts" <<'EOF'
import { Queue, Sub, AWS } from "@intentius/chant-lexicon-aws";

// One queue is enough: the teardown boundary under test is the STACK. The
// name folds in the stack name so the two envs' queues cannot collide.
export const taskQueue = new Queue({
  QueueName: Sub`${AWS.StackName}-tasks`,
  SqsManagedSseEnabled: true,
});
EOF

cat >"$PROJECT/apply.mts" <<'EOF'
// Deploy one built template as one stack through the native applier — the
// exact code path that stamps the template's ownership Metadata as stack tags.
import { awsApply } from "@intentius/chant-lexicon-aws/op/activities";
const [templatePath, stackName] = process.argv.slice(2);
await awsApply({ templatePath: templatePath!, stackName: stackName!, intervalMs: 500 });
EOF

cd "$PROJECT"

# ── 2. Build one template per env — the marker rides the template ────────────
echo "=== 2. Build (dev + staging) ==="
chant build src --lexicon aws -o template-dev.json --param env=dev >/dev/null
chant build src --lexicon aws -o template-staging.json --param env=staging >/dev/null
grep -q '"chant:env": "dev"' template-dev.json \
  || fail "build" "template-dev.json carries no chant:env=dev ownership Metadata"
grep -q '"chant:env": "staging"' template-staging.json \
  || fail "build" "template-staging.json carries no chant:env=staging ownership Metadata"

# ── 3. Deploy both envs + one foreign stack ──────────────────────────────────
echo "=== 3. Deploy dev, staging, and a foreign (untagged) stack ==="
tsx apply.mts template-dev.json dev >/dev/null
tsx apply.mts template-staging.json staging >/dev/null
# The foreign stack: raw CreateStack, no chant tags — someone else's.
cfn 'Action=CreateStack&Version=2010-05-15&StackName=foreign&TemplateBody={"Resources":{"T":{"Type":"AWS::SNS::Topic","Properties":{}}}}' \
  | grep -q StackId || fail "deploy" "could not create the foreign stack"

# The applier must have stamped the marker as the STACK's own tags — the
# identity everything below keys on.
cfn 'Action=DescribeStacks&Version=2010-05-15&StackName=dev' | grep -q '<Key>chant:env</Key><Value>dev</Value>' \
  || fail "tags" "the dev stack's own tags carry no chant:env=dev — the applier did not stamp stack tags"

# ── 4. Plan: exactly the env's marker-verified stack ─────────────────────────
echo "=== 4. chant lifecycle teardown dev (plan) ==="
chant lifecycle teardown dev --json >"$WORK/plan.json" 2>"$WORK/plan.err" \
  || fail "plan" "teardown plan exited nonzero: $(cat "$WORK/plan.err")"
grep -q '"name": "dev"' "$WORK/plan.json" || fail "plan" "the dev stack is not in the plan"
grep -q '"type": "AWS::CloudFormation::Stack"' "$WORK/plan.json" || fail "plan" "the plan entry is not stack-typed"
grep -q '"name": "staging"' "$WORK/plan.json" && fail "plan" "the staging stack leaked into the dev plan"
grep -q '"name": "foreign"' "$WORK/plan.json" && fail "plan" "the foreign stack leaked into the dev plan"

# ── 5. Execute: the dev stack and only the dev stack goes ────────────────────
echo "=== 5. chant lifecycle teardown dev --yes ==="
chant lifecycle teardown dev --yes --json >"$WORK/report.json" 2>"$WORK/report.err" \
  || fail "teardown" "teardown --yes exited nonzero: $(cat "$WORK/report.err")"
grep -q '"outcome": "deleted"' "$WORK/report.json" || fail "teardown" "no deleted outcome in the report"

cfn 'Action=DescribeStacks&Version=2010-05-15&StackName=dev' | grep -qi 'does not exist\|DELETE_COMPLETE' \
  || fail "assert" "the dev stack still exists after teardown"
cfn 'Action=DescribeStacks&Version=2010-05-15&StackName=staging' | grep -q '<StackStatus>CREATE_COMPLETE</StackStatus>' \
  || fail "assert" "the staging stack is gone — teardown crossed the env boundary"
cfn 'Action=DescribeStacks&Version=2010-05-15&StackName=foreign' | grep -q '<StackStatus>CREATE_COMPLETE</StackStatus>' \
  || fail "assert" "the foreign stack is gone — teardown deleted an unmarked stack"

echo "PASS: dev torn down to DELETE_COMPLETE; staging and the foreign stack untouched."
