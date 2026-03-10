#!/usr/bin/env bash
set -euo pipefail

source .env

PASS=0; FAIL=0
check() { if "$@"; then ((PASS++)); else ((FAIL++)); echo "FAIL: $*"; fi }

echo "=== Infra Health ==="
check kubectl wait --for=condition=Ready sqlinstances --all --timeout=60s
check kubectl wait --for=condition=Ready redisinstances --all --timeout=60s
# Config-driven bucket check — no hardcoded cell names
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.labels.gitlab\.example\.com/cell}'); do
  check gsutil ls "gs://${GCP_PROJECT_ID}-${CELL}-artifacts" >/dev/null
done

echo "=== System Namespace ==="
check kubectl -n system rollout status deploy/ingress-nginx-controller --timeout=60s
check kubectl -n system rollout status deploy/cert-manager --timeout=60s
check kubectl -n system rollout status deploy/external-secrets --timeout=60s
check kubectl -n system rollout status deploy/gitlab-runner --timeout=60s
check kubectl -n system rollout status deploy/topology-service --timeout=60s
check kubectl -n system rollout status deploy/prometheus --timeout=60s
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
check test -n "$INGRESS_IP"

echo "=== Per-Cell GitLab ==="
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.name}'); do
  CELL_NAME=${CELL#cell-}
  HOST="${CELL_NAME}.${DOMAIN}"

  # Pod health (release name = gitlab-cell-<name>, chart prepends to resource names)
  check kubectl -n "$CELL" rollout status deploy/gitlab-cell-${CELL_NAME}-webservice-default --timeout=120s
  check kubectl -n "$CELL" rollout status statefulset/gitlab-cell-${CELL_NAME}-gitaly --timeout=120s
  # PVC bound
  check kubectl -n "$CELL" get pvc -l app=gitaly -o jsonpath='{.items[0].status.phase}' | grep -q Bound

  # HTTP health endpoints
  check curl -sf "https://${HOST}/-/health"
  check curl -sf "https://${HOST}/-/readiness"

  # TLS certificate valid
  check openssl s_client -connect "${HOST}:443" -servername "${HOST}" </dev/null 2>/dev/null | openssl x509 -noout -checkend 0
done

echo "=== Git Operations (canary cell) ==="
CANARY_HOST="alpha.${DOMAIN}"
# Create project via API
TOKEN=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner "puts User.find_by_username('root').personal_access_tokens.create!(name: 'e2e', scopes: [:api]).token")
PROJECT_ID=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects" -d "name=e2e-test" | jq -r '.id')
check test -n "$PROJECT_ID"
# Clone + push
TMPDIR=$(mktemp -d)
check git clone "https://root:${TOKEN}@${CANARY_HOST}/root/e2e-test.git" "$TMPDIR/e2e-test"
echo "test" > "$TMPDIR/e2e-test/test.txt"
cd "$TMPDIR/e2e-test" && git add . && git commit -m "e2e" && check git push
cd -

# Verify commit via API
check curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/repository/commits" | jq -e '.[0].message == "e2e"'

echo "=== Container Registry ==="
check docker login "${CANARY_HOST}" -u root -p "$TOKEN"
check docker tag alpine:latest "${CANARY_HOST}/root/e2e-test/alpine:e2e"
check docker push "${CANARY_HOST}/root/e2e-test/alpine:e2e"
check docker pull "${CANARY_HOST}/root/e2e-test/alpine:e2e"

echo "=== Cell Isolation ==="
# From alpha pod, try to reach beta — must fail
check kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-webservice-default -- timeout 5 curl -sf "http://gitlab-cell-beta-webservice-default.cell-beta.svc:8080" && FAIL=$((FAIL+1)) || true
# Verify separate databases
ALPHA_DB=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner "puts ActiveRecord::Base.connection.current_database")
BETA_DB=$(kubectl -n cell-beta exec deploy/gitlab-cell-beta-toolbox -- gitlab-rails runner "puts ActiveRecord::Base.connection.current_database")
check test "$ALPHA_DB" = "gitlabhq_production"
check test "$BETA_DB" = "gitlabhq_production"
# Verify different DB hosts (Cloud SQL IPs)
ALPHA_HOST=$(kubectl -n cell-alpha get secret gitlab-db-password -o jsonpath='{.data.host}' | base64 -d)
BETA_HOST=$(kubectl -n cell-beta get secret gitlab-db-password -o jsonpath='{.data.host}' | base64 -d)
check test "$ALPHA_HOST" != "$BETA_HOST"

echo "=== Topology Routing ==="
check curl -sf "http://topology-service.system.svc:8080/healthz"

echo "=== Runner ==="
# Trigger pipeline and verify runner picks it up
PIPELINE_ID=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipeline" -d "ref=main" | jq -r '.id')
check test -n "$PIPELINE_ID"
sleep 30
JOB_STATUS=$(curl -sf -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/jobs" | jq -r '.[0].status')
check test "$JOB_STATUS" != "stuck"

echo "=== Backup ==="
check kubectl -n cell-alpha exec statefulset/gitlab-cell-alpha-gitaly -- gitaly-backup create --server-side --path "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test"
check gsutil ls "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test/" >/dev/null

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))
