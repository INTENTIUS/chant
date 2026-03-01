#!/usr/bin/env bash
set -euo pipefail

# End-to-end smoke tests — deploy, verify, and tear down all 8 examples.
#
# Usage: e2e-smoke.sh [k8s|aws|eks|all]
#   k8s — flyway-postgresql-k8s, k8s-batch-workers, k8s-web-platform (needs Docker socket)
#   aws — gitlab-aws-alb-{infra,api,ui}, flyway-postgresql-gitlab-aws-rds (needs AWS + GitLab)
#   eks — k8s-eks-microservice (needs AWS + domain)
#   all — everything

GROUP="${1:-all}"

PASS=0
FAIL=0
ERRORS=""

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); ERRORS="${ERRORS}\n  - $1"; }

# ── Helpers ───────────────────────────────────────────────────────────────────

setup_example() {
  # $1 = example name, remaining args = tarball paths
  local name="$1"; shift
  local dir="/tmp/e2e-$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  cd "$dir"

  cat > package.json <<'PKGJSON'
{ "name": "test-project", "version": "0.0.1", "type": "module" }
PKGJSON

  # Install core + all required lexicon tarballs
  npm install --no-audit --no-fund /tarballs/core.tgz "$@"

  # Copy example source
  cp -r "/examples/$name/src" src/

  # Copy sql/ if present (flyway examples)
  if [ -d "/examples/$name/sql" ]; then
    cp -r "/examples/$name/sql" sql/
  fi

  # Copy flyway.toml if present
  if [ -f "/examples/$name/flyway.toml" ]; then
    cp "/examples/$name/flyway.toml" flyway.toml
  fi

  # Copy .env.example as .env if present
  if [ -f "/examples/$name/.env.example" ]; then
    cp "/examples/$name/.env.example" .env
  fi

  # Copy Dockerfile if present
  if [ -f "/examples/$name/Dockerfile" ]; then
    cp "/examples/$name/Dockerfile" Dockerfile
  fi

  # Copy scripts/ if present
  if [ -d "/examples/$name/scripts" ]; then
    cp -r "/examples/$name/scripts" scripts/
  fi

  # Copy setup.sh if present
  if [ -f "/examples/$name/setup.sh" ]; then
    cp "/examples/$name/setup.sh" setup.sh
  fi

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

# ── K8s local group ──────────────────────────────────────────────────────────

K3D_CLUSTER="chant-e2e"

create_k3d_cluster() {
  echo ""
  echo "=== Creating k3d cluster: $K3D_CLUSTER ==="
  # Port 30432 for flyway-postgresql-k8s NodePort
  if k3d cluster list | grep -q "$K3D_CLUSTER"; then
    echo "Cluster $K3D_CLUSTER already exists, reusing"
  else
    k3d cluster create "$K3D_CLUSTER" \
      -p "30432:30432@server:0" \
      --wait --timeout 120s
  fi
  echo "Cluster ready"
}

delete_k3d_cluster() {
  echo ""
  echo "=== Deleting k3d cluster: $K3D_CLUSTER ==="
  k3d cluster delete "$K3D_CLUSTER" 2>/dev/null || true
}

test_flyway_postgresql_k8s() {
  local name="flyway-postgresql-k8s"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-k8s.tgz /tarballs/lexicon-flyway.tgz

  # Build
  if npx chant build src --lexicon k8s -o k8s.yaml 2>&1; then
    pass "$name: chant build k8s"
  else
    fail "$name: chant build k8s"; return
  fi

  if npx chant build src --lexicon flyway -o flyway.toml 2>&1; then
    pass "$name: chant build flyway"
  else
    fail "$name: chant build flyway"; return
  fi

  # Deploy
  if kubectl apply -f k8s.yaml 2>&1; then
    pass "$name: kubectl apply"
  else
    fail "$name: kubectl apply"; return
  fi

  # Wait for postgres to be ready
  if kubectl -n flyway-pg rollout status statefulset/postgres --timeout=120s 2>&1; then
    pass "$name: postgres rollout"
  else
    fail "$name: postgres rollout"
  fi

  # Run flyway migrations
  if flyway migrate -environment=local 2>&1; then
    pass "$name: flyway migrate"
  else
    fail "$name: flyway migrate"
  fi

  # Verify migrations applied
  local info_output
  info_output=$(flyway info -environment=local 2>&1)
  if echo "$info_output" | grep -q "Success"; then
    pass "$name: flyway info shows success"
  else
    fail "$name: flyway info shows success"
    echo "$info_output"
  fi

  # Verify tables exist in postgres
  local tables
  tables=$(kubectl -n flyway-pg exec postgres-0 -- psql -U postgres -d app -t -c '\dt' 2>&1) || true
  if echo "$tables" | grep -q "users"; then
    pass "$name: users table exists"
  else
    fail "$name: users table exists"
  fi
  if echo "$tables" | grep -q "orders"; then
    pass "$name: orders table exists"
  else
    fail "$name: orders table exists"
  fi

  # Teardown
  kubectl delete -f k8s.yaml --ignore-not-found 2>&1 || true
  echo "  Teardown complete: $name"
}

test_k8s_batch_workers() {
  local name="k8s-batch-workers"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-k8s.tgz

  # Build
  if npx chant build src --lexicon k8s -o k8s.yaml 2>&1; then
    pass "$name: chant build"
  else
    fail "$name: chant build"; return
  fi

  # Deploy
  if kubectl apply -f k8s.yaml 2>&1; then
    pass "$name: kubectl apply"
  else
    fail "$name: kubectl apply"; return
  fi

  # Wait for deployment
  if kubectl -n batch-workers rollout status deployment/queue-worker --timeout=120s 2>&1; then
    pass "$name: queue-worker rollout"
  else
    fail "$name: queue-worker rollout"
  fi

  # Verify pods running
  local pods
  pods=$(kubectl get pods -n batch-workers --no-headers 2>&1) || true
  if echo "$pods" | grep -q "Running"; then
    pass "$name: pods running"
  else
    fail "$name: pods running"
    echo "$pods"
  fi

  # Teardown
  kubectl delete -f k8s.yaml --ignore-not-found 2>&1 || true
  echo "  Teardown complete: $name"
}

test_k8s_web_platform() {
  local name="k8s-web-platform"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-k8s.tgz

  # Build
  if npx chant build src --lexicon k8s -o k8s.yaml 2>&1; then
    pass "$name: chant build"
  else
    fail "$name: chant build"; return
  fi

  # Deploy
  if kubectl apply -f k8s.yaml 2>&1; then
    pass "$name: kubectl apply"
  else
    fail "$name: kubectl apply"; return
  fi

  # Wait for frontend deployment
  if kubectl -n web-platform rollout status deployment/frontend --timeout=120s 2>&1; then
    pass "$name: frontend rollout"
  else
    fail "$name: frontend rollout"
  fi

  # Verify pods running
  local pods
  pods=$(kubectl get pods -n web-platform --no-headers 2>&1) || true
  if echo "$pods" | grep -q "Running"; then
    pass "$name: pods running"
  else
    fail "$name: pods running"
    echo "$pods"
  fi

  # Verify ingress created
  local ingress
  ingress=$(kubectl get ingress -n web-platform --no-headers 2>&1) || true
  if [ -n "$ingress" ] && ! echo "$ingress" | grep -q "No resources"; then
    pass "$name: ingress created"
  else
    fail "$name: ingress created"
  fi

  # Teardown
  kubectl delete -f k8s.yaml --ignore-not-found 2>&1 || true
  echo "  Teardown complete: $name"
}

run_k8s_group() {
  echo ""
  echo "========================================"
  echo "  K8s local E2E tests"
  echo "========================================"

  create_k3d_cluster
  trap 'delete_k3d_cluster' EXIT

  test_flyway_postgresql_k8s
  test_k8s_batch_workers
  test_k8s_web_platform

  delete_k3d_cluster
  trap - EXIT
}

# ── AWS/GitLab group ─────────────────────────────────────────────────────────

GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"
GITLAB_PROJECTS_CREATED=()
CF_STACKS_CREATED=()

gitlab_api() {
  # $1 = method, $2 = path, $3 = data (optional)
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
  # $1 = project name; returns project ID
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
  # $1 = project ID
  gitlab_api GET "/projects/$1" | jq -r '.http_url_to_repo'
}

push_to_gitlab() {
  # $1 = project ID; pushes current dir to GitLab
  local project_id="$1"
  local url
  url=$(gitlab_get_project_url "$project_id")
  # Inject token into URL for auth
  local auth_url
  auth_url=$(echo "$url" | sed "s|https://|https://oauth2:${GITLAB_TOKEN}@|")

  git init
  git remote add origin "$auth_url"
  git add -A
  git commit -m "E2E smoke test"
  git push -u origin main
}

wait_for_pipeline() {
  # $1 = project ID; waits for latest pipeline to complete
  local project_id="$1"
  local timeout=600  # 10 minutes
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

cleanup_aws_gitlab() {
  echo ""
  echo "=== Cleaning up AWS/GitLab resources ==="

  # Delete CF stacks in reverse order
  for stack in $(echo "${CF_STACKS_CREATED[@]}" | tr ' ' '\n' | tac); do
    echo "  Deleting CF stack: $stack"
    aws cloudformation delete-stack --stack-name "$stack" 2>/dev/null || true
  done
  for stack in $(echo "${CF_STACKS_CREATED[@]}" | tr ' ' '\n' | tac); do
    echo "  Waiting for stack deletion: $stack"
    aws cloudformation wait stack-delete-complete --stack-name "$stack" 2>/dev/null || true
  done

  # Delete GitLab projects
  for project_id in "${GITLAB_PROJECTS_CREATED[@]}"; do
    echo "  Deleting GitLab project: $project_id"
    gitlab_api DELETE "/projects/$project_id" 2>/dev/null || true
  done
}

test_gitlab_aws_alb_infra() {
  local name="gitlab-aws-alb-infra"
  local stack_name="chant-e2e-shared-alb"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  # Build
  mkdir -p templates
  if npx chant build src --lexicon aws -o templates/template.json 2>&1; then
    pass "$name: chant build aws"
  else
    fail "$name: chant build aws"; return
  fi

  if npx chant build src --lexicon gitlab -o .gitlab-ci.yml 2>&1; then
    pass "$name: chant build gitlab"
  else
    fail "$name: chant build gitlab"; return
  fi

  # Create GitLab project and push
  local project_id
  project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

  # Override stack name in CI config to use our prefixed name
  sed -i "s/shared-alb/$stack_name/g" .gitlab-ci.yml 2>/dev/null || true

  push_to_gitlab "$project_id"

  # Wait for pipeline
  if wait_for_pipeline "$project_id"; then
    pass "$name: pipeline succeeded"
  else
    fail "$name: pipeline failed"
    return
  fi

  # Verify CF stack
  local stack_status
  stack_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' --output text 2>&1) || true
  if echo "$stack_status" | grep -q "CREATE_COMPLETE\|UPDATE_COMPLETE"; then
    pass "$name: stack $stack_name is $stack_status"
    CF_STACKS_CREATED+=("$stack_name")
  else
    fail "$name: stack status is $stack_status (expected CREATE_COMPLETE)"
  fi

  # Verify stack outputs exist
  local outputs
  outputs=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].Outputs' --output json 2>&1) || true
  if echo "$outputs" | jq -e 'length > 0' >/dev/null 2>&1; then
    pass "$name: stack has outputs"
  else
    fail "$name: stack has outputs"
  fi
}

test_gitlab_aws_alb_api() {
  local name="gitlab-aws-alb-api"
  local stack_name="chant-e2e-shared-alb-api"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  # Build
  mkdir -p templates
  if npx chant build src --lexicon aws -o templates/template.json 2>&1; then
    pass "$name: chant build aws"
  else
    fail "$name: chant build aws"; return
  fi

  if npx chant build src --lexicon gitlab -o .gitlab-ci.yml 2>&1; then
    pass "$name: chant build gitlab"
  else
    fail "$name: chant build gitlab"; return
  fi

  # Create GitLab project and push
  local project_id
  project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

  sed -i "s/shared-alb-api/$stack_name/g" .gitlab-ci.yml 2>/dev/null || true

  push_to_gitlab "$project_id"

  if wait_for_pipeline "$project_id"; then
    pass "$name: pipeline succeeded"
  else
    fail "$name: pipeline failed"
    return
  fi

  # Verify CF stack
  local stack_status
  stack_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' --output text 2>&1) || true
  if echo "$stack_status" | grep -q "CREATE_COMPLETE\|UPDATE_COMPLETE"; then
    pass "$name: stack $stack_name is $stack_status"
    CF_STACKS_CREATED+=("$stack_name")
  else
    fail "$name: stack status is $stack_status"
  fi
}

test_gitlab_aws_alb_ui() {
  local name="gitlab-aws-alb-ui"
  local stack_name="chant-e2e-shared-alb-ui"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-aws.tgz /tarballs/lexicon-gitlab.tgz

  # Build
  mkdir -p templates
  if npx chant build src --lexicon aws -o templates/template.json 2>&1; then
    pass "$name: chant build aws"
  else
    fail "$name: chant build aws"; return
  fi

  if npx chant build src --lexicon gitlab -o .gitlab-ci.yml 2>&1; then
    pass "$name: chant build gitlab"
  else
    fail "$name: chant build gitlab"; return
  fi

  # Create GitLab project and push
  local project_id
  project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

  sed -i "s/shared-alb-ui/$stack_name/g" .gitlab-ci.yml 2>/dev/null || true

  push_to_gitlab "$project_id"

  if wait_for_pipeline "$project_id"; then
    pass "$name: pipeline succeeded"
  else
    fail "$name: pipeline failed"
    return
  fi

  # Verify CF stack
  local stack_status
  stack_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' --output text 2>&1) || true
  if echo "$stack_status" | grep -q "CREATE_COMPLETE\|UPDATE_COMPLETE"; then
    pass "$name: stack $stack_name is $stack_status"
    CF_STACKS_CREATED+=("$stack_name")
  else
    fail "$name: stack status is $stack_status"
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

  # Create SSM parameter for DB password
  local db_password
  db_password=$(openssl rand -hex 16)
  aws ssm put-parameter --name "$ssm_path" --type SecureString \
    --value "$db_password" --overwrite 2>&1 || true

  # Build all 3 lexicons
  mkdir -p templates
  if npx chant build src --lexicon aws -o templates/template.json 2>&1; then
    pass "$name: chant build aws"
  else
    fail "$name: chant build aws"; return
  fi

  if npx chant build src --lexicon flyway -o flyway.toml 2>&1; then
    pass "$name: chant build flyway"
  else
    fail "$name: chant build flyway"; return
  fi

  if npx chant build src --lexicon gitlab -o .gitlab-ci.yml 2>&1; then
    pass "$name: chant build gitlab"
  else
    fail "$name: chant build gitlab"; return
  fi

  # Create GitLab project and push
  local project_id
  project_id=$(create_gitlab_project "chant-e2e-$name-$(date +%s)")

  # Override stack name and SSM path in CI config
  sed -i "s|flyway-rds|$stack_name|g" .gitlab-ci.yml 2>/dev/null || true

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
    CF_STACKS_CREATED+=("$stack_name")
  else
    fail "$name: stack status is $stack_status"
  fi

  # Cleanup SSM parameter
  aws ssm delete-parameter --name "$ssm_path" 2>/dev/null || true
}

run_aws_group() {
  echo ""
  echo "========================================"
  echo "  AWS/GitLab E2E tests"
  echo "========================================"

  require_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION GITLAB_TOKEN GITLAB_GROUP

  trap 'cleanup_aws_gitlab' EXIT

  # Deploy infra first (others depend on it)
  test_gitlab_aws_alb_infra

  # API and UI can run after infra
  test_gitlab_aws_alb_api
  test_gitlab_aws_alb_ui

  # Flyway RDS is independent
  test_flyway_postgresql_gitlab_aws_rds

  # Cleanup runs via trap
}

# ── EKS group ────────────────────────────────────────────────────────────────

test_k8s_eks_microservice() {
  local name="k8s-eks-microservice"
  local stack_name="chant-e2e-eks-microservice"
  echo ""
  echo "=== E2E: $name ==="

  setup_example "$name" /tarballs/lexicon-aws.tgz /tarballs/lexicon-k8s.tgz

  # Set up .env with placeholder values for initial build
  cp .env .env.backup

  # Build AWS infra template
  mkdir -p templates
  if npx chant build src --lexicon aws -o templates/infra.json 2>&1; then
    pass "$name: chant build aws"
  else
    fail "$name: chant build aws"; return
  fi

  # Deploy CloudFormation stack
  echo "  Deploying CF stack: $stack_name (this may take 15-20 minutes)..."
  if aws cloudformation deploy \
      --template-file templates/infra.json \
      --stack-name "$stack_name" \
      --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides "domainName=$EKS_DOMAIN" \
      --no-fail-on-empty-changeset 2>&1; then
    pass "$name: CF deploy"
  else
    fail "$name: CF deploy"; return
  fi

  # Configure kubectl for the EKS cluster
  if aws eks update-kubeconfig --name "$stack_name" 2>&1; then
    pass "$name: kubeconfig updated"
  else
    fail "$name: kubeconfig updated"; return
  fi

  # Load stack outputs into .env
  local stack
  stack=$(aws cloudformation describe-stacks --stack-name "$stack_name" --output json)
  get_output() { echo "$stack" | jq -r ".Stacks[0].Outputs[] | select(.OutputKey==\"$1\") | .OutputValue"; }
  get_param() { echo "$stack" | jq -r ".Stacks[0].Parameters[] | select(.ParameterKey==\"$1\") | .ParameterValue"; }

  cat > .env <<ENVEOF
APP_ROLE_ARN=$(get_output appRoleArn)
EXTERNAL_DNS_ROLE_ARN=$(get_output externalDnsRoleArn)
FLUENT_BIT_ROLE_ARN=$(get_output fluentBitRoleArn)
ADOT_ROLE_ARN=$(get_output adotRoleArn)
ALB_CERT_ARN=
HOSTED_ZONE_ID=$(get_output hostedZoneIdOutput)
DOMAIN=$(get_param domainName)
EKS_CLUSTER_NAME=$stack_name
AWS_REGION=${AWS_DEFAULT_REGION}
ENVEOF

  # Rebuild K8s manifest with real ARNs
  if npx chant build src --lexicon k8s -o k8s.yaml 2>&1; then
    pass "$name: chant build k8s (with ARNs)"
  else
    fail "$name: chant build k8s (with ARNs)"; return
  fi

  # Deploy K8s workloads
  if kubectl apply -f k8s.yaml 2>&1; then
    pass "$name: kubectl apply"
  else
    fail "$name: kubectl apply"
  fi

  # Wait for deployment
  if kubectl -n microservice rollout status deployment/microservice-api --timeout=300s 2>&1; then
    pass "$name: microservice-api rollout"
  else
    fail "$name: microservice-api rollout"
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

  # Teardown — delete K8s resources then CF stack
  echo "  Tearing down $name..."
  kubectl delete -f k8s.yaml --ignore-not-found 2>&1 || true
  sleep 30  # Wait for ALB drainage
  aws cloudformation delete-stack --stack-name "$stack_name" 2>/dev/null || true
  echo "  Waiting for stack deletion..."
  aws cloudformation wait stack-delete-complete --stack-name "$stack_name" 2>/dev/null || true
  echo "  Teardown complete: $name"
}

run_eks_group() {
  echo ""
  echo "========================================"
  echo "  EKS E2E tests"
  echo "========================================"

  require_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION EKS_DOMAIN

  test_k8s_eks_microservice
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo "========================================"
echo "  Chant E2E smoke tests"
echo "  Group: $GROUP"
echo "========================================"

case "$GROUP" in
  k8s)
    run_k8s_group
    ;;
  aws)
    run_aws_group
    ;;
  eks)
    run_eks_group
    ;;
  all)
    run_k8s_group
    run_aws_group
    run_eks_group
    ;;
  *)
    echo "Unknown group: $GROUP"
    echo "Usage: $0 [k8s|aws|eks|all]"
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
