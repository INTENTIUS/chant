#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke tests — deploy, verify, and tear down examples.
# Delegates to each example's own npm scripts (run/deploy/teardown/build).
#
# Usage: e2e-smoke.sh [aws|eks|all]
#   aws — gitlab-aws-alb-{infra,api,ui}, flyway-postgresql-gitlab-aws-rds (needs AWS + GitLab)
#   eks — k8s-eks-microservice (needs AWS + domain)
#   all — everything

GROUP="${1:-all}"

PASS=0
FAIL=0
ERRORS=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  - $1"; }

# ── Global cleanup registry ──────────────────────────────────────────────────
# Resources registered BEFORE creation so crash mid-create still cleans up.

GITLAB_PROJECTS_CREATED=()        # GitLab project IDs to delete
CF_STACKS_CREATED=()              # CF stack names to delete (reverse order)
SSM_PARAMS_CREATED=()             # SSM parameter paths to delete
EKS_TEARDOWN_DIR=""               # dir with k8s.yaml + scripts/teardown.sh

cleanup_all() {
  echo ""
  echo "=== Cleanup ==="

  # EKS: run the example's own teardown if available
  if [ -n "$EKS_TEARDOWN_DIR" ] && [ -f "$EKS_TEARDOWN_DIR/scripts/teardown.sh" ]; then
    echo "  Running EKS example teardown..."
    (cd "$EKS_TEARDOWN_DIR" && bash scripts/teardown.sh) 2>/dev/null || true
  fi

  # CF stacks in reverse order (safety net)
  local i
  for (( i=${#CF_STACKS_CREATED[@]}-1; i>=0; i-- )); do
    local stack="${CF_STACKS_CREATED[$i]}"
    [ -z "$stack" ] && continue
    echo "  Deleting CF stack: $stack"
    aws cloudformation delete-stack --stack-name "$stack" 2>/dev/null || true
  done
  for (( i=${#CF_STACKS_CREATED[@]}-1; i>=0; i-- )); do
    local stack="${CF_STACKS_CREATED[$i]}"
    [ -z "$stack" ] && continue
    echo "  Waiting for stack deletion: $stack"
    aws cloudformation wait stack-delete-complete --stack-name "$stack" 2>/dev/null || true
  done

  # SSM parameters
  for param in "${SSM_PARAMS_CREATED[@]}"; do
    echo "  Deleting SSM parameter: $param"
    aws ssm delete-parameter --name "$param" 2>/dev/null || true
  done

  # GitLab projects
  for project_id in "${GITLAB_PROJECTS_CREATED[@]}"; do
    echo "  Deleting GitLab project: $project_id"
    gitlab_api DELETE "/projects/$project_id" 2>/dev/null || true
  done

  echo "  Cleanup complete"
}

trap 'cleanup_all' EXIT

# ── Helpers ───────────────────────────────────────────────────────────────────

setup_example() {
  # $1 = example name, remaining args = tarball paths
  local name="$1"; shift
  local dir="/tmp/e2e-$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  # Merge example's npm scripts into a minimal package.json
  local example_scripts
  example_scripts=$(jq -c '.scripts // {}' "/examples/$name/package.json")
  jq -n --argjson scripts "$example_scripts" \
    '{"name":"test-project","version":"0.0.1","type":"module","scripts":$scripts}' > package.json

  # Install core + required lexicon tarballs
  npm install --no-audit --no-fund /tarballs/core.tgz "$@"

  # Copy example source and supporting files
  cp -r "/examples/$name/src" src/
  for item in sql flyway.toml Dockerfile scripts setup.sh; do
    if [ -e "/examples/$name/$item" ]; then
      cp -r "/examples/$name/$item" "$item"
    fi
  done

  # .env.example -> .env
  if [ -f "/examples/$name/.env.example" ]; then
    cp "/examples/$name/.env.example" .env
  fi

  # Ensure templates/ exists for examples that output to it
  mkdir -p templates

  echo "$dir"
}

require_env() {
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      echo "ERROR: Required env var $var is not set" >&2
      exit 1
    fi
  done
}

# ── AWS/GitLab group ─────────────────────────────────────────────────────────

GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"

gitlab_api() {
  local method="$1" path="$2" data="${3:-}"
  local url="${GITLAB_URL}/api/v4${path}"
  if [ -n "$data" ]; then
    curl -fsSL -X "$method" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
      -H "Content-Type: application/json" -d "$data" "$url"
  else
    curl -fsSL -X "$method" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$url"
  fi
}

create_gitlab_project() {
  local project_name="$1"
  local response
  response=$(gitlab_api POST "/projects" \
    "{\"name\":\"$project_name\",\"namespace_id\":$(gitlab_get_group_id),\"visibility\":\"private\",\"initialize_with_readme\":false}")
  local project_id
  project_id=$(echo "$response" | jq -r '.id')
  GITLAB_PROJECTS_CREATED+=("$project_id")
  echo "$project_id"
}

gitlab_get_group_id() {
  gitlab_api GET "/groups?search=$GITLAB_GROUP" | jq -r '.[0].id'
}

gitlab_get_project_url() {
  gitlab_api GET "/projects/$1" | jq -r '.http_url_to_repo'
}

push_to_gitlab() {
  local project_id="$1"
  local url
  url=$(gitlab_get_project_url "$project_id")
  local auth_url
  auth_url=$(echo "$url" | sed "s|https://|https://oauth2:${GITLAB_TOKEN}@|")

  git init -b main
  git config user.email "e2e@chant.dev"
  git config user.name "Chant E2E"
  git remote add origin "$auth_url"
  git add -A
  git commit -m "E2E smoke test"
  git push -u origin main
}

wait_for_pipeline() {
  local project_id="$1"
  local timeout=600
  local elapsed=0
  local status=""

  echo "  Waiting for GitLab pipeline..."
  while [ "$elapsed" -lt "$timeout" ]; do
    status=$(gitlab_api GET "/projects/$project_id/pipelines?per_page=1" | jq -r '.[0].status // "pending"')
    case "$status" in
      success) echo "  Pipeline succeeded"; return 0 ;;
      failed|canceled) echo "  Pipeline $status"; return 1 ;;
      *) sleep 15; elapsed=$((elapsed + 15)) ;;
    esac
  done
  echo "  Pipeline timed out after ${timeout}s (status: $status)"
  return 1
}

test_gitlab_example() {
  # Generic test for GitLab/AWS CI-only examples.
  # $1 = example name, $2 = e2e stack name, $3 = original stack name, remaining = tarballs
  local name="$1" stack_name="$2" orig_stack_name="$3"; shift 3
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" "$@"

  # Build — confirms chant build works in E2E image
  if npm run build 2>&1; then
    pass "$name: npm run build"
  else
    fail "$name: npm run build"; return
  fi

  # Full GitLab pipeline (optional — requires GITLAB_TOKEN)
  if [ -n "${GITLAB_TOKEN:-}" ]; then
    local project_id
    project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

    # Override stack name in CI config for isolated E2E run
    sed -i "s/${orig_stack_name}/${stack_name}/g" .gitlab-ci.yml 2>/dev/null || true

    CF_STACKS_CREATED+=("$stack_name")

    push_to_gitlab "$project_id"

    if wait_for_pipeline "$project_id"; then
      pass "$name: pipeline succeeded"
    else
      fail "$name: pipeline failed"
      return
    fi

    # Verify CF stack exists
    local stack_status
    stack_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
      --query 'Stacks[0].StackStatus' --output text 2>&1) || true
    if echo "$stack_status" | grep -q "CREATE_COMPLETE\|UPDATE_COMPLETE"; then
      pass "$name: stack $stack_name is $stack_status"
    else
      fail "$name: stack status is $stack_status"
    fi
  else
    echo "  SKIP: GitLab pipeline (GITLAB_TOKEN not set)"
  fi
}

test_flyway_postgresql_gitlab_aws_rds() {
  local name="flyway-postgresql-gitlab-aws-rds"
  local stack_name="chant-e2e-flyway-rds"
  local ssm_path="/chant-e2e/flyway-rds/db-password"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" \
    /tarballs/lexicon-aws.tgz /tarballs/lexicon-flyway.tgz /tarballs/lexicon-gitlab.tgz

  # Build
  if npm run build 2>&1; then
    pass "$name: npm run build"
  else
    fail "$name: npm run build"; return
  fi

  # Full GitLab pipeline (optional)
  if [ -n "${GITLAB_TOKEN:-}" ]; then
    # Create SSM parameter for DB password (register for cleanup first)
    SSM_PARAMS_CREATED+=("$ssm_path")
    local db_password
    db_password=$(openssl rand -hex 16)
    aws ssm put-parameter --name "$ssm_path" --type SecureString \
      --value "$db_password" --overwrite 2>&1 || true

    local project_id
    project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

    sed -i "s|flyway-rds|$stack_name|g" .gitlab-ci.yml 2>/dev/null || true

    CF_STACKS_CREATED+=("$stack_name")

    push_to_gitlab "$project_id"

    if wait_for_pipeline "$project_id"; then
      pass "$name: pipeline succeeded"
    else
      fail "$name: pipeline failed"
    fi

    # Verify CF stack
    local stack_status
    stack_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
      --query 'Stacks[0].StackStatus' --output text 2>&1) || true
    if echo "$stack_status" | grep -q "CREATE_COMPLETE\|UPDATE_COMPLETE"; then
      pass "$name: stack $stack_name is $stack_status"
    else
      fail "$name: stack status is $stack_status"
    fi
  else
    echo "  SKIP: GitLab pipeline (GITLAB_TOKEN not set)"
  fi
}

run_aws_group() {
  echo ""
  echo "========================================"
  echo "  AWS/GitLab E2E tests"
  echo "========================================"

  if [ -n "${GITLAB_TOKEN:-}" ]; then
    # AWS creds can come from env vars or ~/.aws/credentials
    if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ ! -f /root/.aws/credentials ]; then
      echo "ERROR: AWS credentials required (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or mount ~/.aws)" >&2
      exit 1
    fi
    require_env GITLAB_GROUP
    : "${AWS_DEFAULT_REGION:=us-east-2}"
  fi

  # Build always runs; pipeline deploy only when GITLAB_TOKEN is set
  test_gitlab_example "gitlab-aws-alb-infra" "chant-e2e-shared-alb" "shared-alb" \
    /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  test_gitlab_example "gitlab-aws-alb-api" "chant-e2e-shared-alb-api" "shared-alb-api" \
    /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  test_gitlab_example "gitlab-aws-alb-ui" "chant-e2e-shared-alb-ui" "shared-alb-ui" \
    /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  test_flyway_postgresql_gitlab_aws_rds
}

# ── EKS group ────────────────────────────────────────────────────────────────

test_k8s_eks_microservice() {
  local name="k8s-eks-microservice"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-aws.tgz /tarballs/lexicon-k8s.tgz

  # Export env vars the example's scripts expect
  export DOMAIN="${EKS_DOMAIN}"
  export AWS_REGION="${AWS_DEFAULT_REGION}"

  # Register for cleanup safety net (stack name hardcoded in example as "eks-microservice")
  CF_STACKS_CREATED+=("eks-microservice")
  EKS_TEARDOWN_DIR="$(pwd)"

  # npm run deploy = build -> deploy-infra -> configure-kubectl -> load-outputs
  #                  -> build:k8s -> apply -> wait -> status
  echo "  Running npm run deploy (CF stack creation may take 15-20 minutes)..."
  if npm run deploy 2>&1; then
    pass "$name: npm run deploy"
  else
    fail "$name: npm run deploy"; return
  fi

  # Verify pods running
  local pods
  pods=$(kubectl get pods -n microservice --no-headers 2>&1) || true
  if echo "$pods" | grep -q "Running"; then
    pass "$name: pods running"
  else
    fail "$name: pods running"
    echo "$pods"
  fi

  # Teardown via example's own script
  if npm run teardown 2>&1; then
    pass "$name: teardown"
    EKS_TEARDOWN_DIR=""
  else
    fail "$name: teardown"
  fi
}

run_eks_group() {
  echo ""
  echo "========================================"
  echo "  EKS E2E tests"
  echo "========================================"

  EKS_DOMAIN="${EKS_DOMAIN:-api.eks-microservice-demo.dev}"
  # AWS creds can come from env vars or ~/.aws/credentials
  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ ! -f /root/.aws/credentials ]; then
    echo "ERROR: AWS credentials required (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or mount ~/.aws)" >&2
    exit 1
  fi
  : "${AWS_DEFAULT_REGION:=us-east-2}"

  test_k8s_eks_microservice
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo "========================================"
echo "  Chant E2E smoke tests"
echo "  Group: $GROUP"
echo "========================================"

case "$GROUP" in
  aws) run_aws_group ;;
  eks) run_eks_group ;;
  all)
    run_aws_group
    run_eks_group
    ;;
  *)
    echo "Unknown group: $GROUP"
    echo "Usage: $0 [aws|eks|all]"
    exit 1
    ;;
esac

# ── Results ──────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo "  E2E Results: $PASS passed, $FAIL failed"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\nFailures:$ERRORS"
  exit 1
fi
