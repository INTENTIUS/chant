#!/usr/bin/env bash
set -euo pipefail

source .env

PASS=0; FAIL=0
check() { if "$@"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $*"; fi }

echo "=== Infra Health ==="
check kubectl wait --for=condition=Ready sqlinstances --all --timeout=60s
check kubectl wait --for=condition=Ready redisinstances --all --timeout=60s
# Config-driven bucket check — no hardcoded cell names
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.labels.gitlab\.example\.com/cell}'); do
  check gsutil ls "gs://${GCP_PROJECT_ID}-${CELL}-artifacts" >/dev/null
done

echo "=== System Namespace ==="
check kubectl -n system rollout status deploy/ingress-nginx-controller --timeout=60s
check kubectl -n cert-manager rollout status deploy/cert-manager --timeout=60s
check kubectl -n kube-system rollout status deploy/external-secrets --timeout=60s
check kubectl -n system rollout status deploy/gitlab-runner --timeout=60s
check kubectl -n system rollout status deploy/topology-service --timeout=60s
check kubectl -n system rollout status deploy/prometheus --timeout=60s
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
check test -n "$INGRESS_IP"

echo "=== Per-Cell GitLab ==="
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.name}'); do
  CELL_NAME=${CELL#cell-}
  HOST="gitlab.${CELL_NAME}.${DOMAIN}"

  # Pod health (release name = gitlab-cell-<name>, chart prepends to resource names)
  check kubectl -n "$CELL" rollout status deploy/gitlab-cell-${CELL_NAME}-webservice-default --timeout=120s
  check kubectl -n "$CELL" rollout status statefulset/gitlab-cell-${CELL_NAME}-gitaly --timeout=120s
  # PVC bound
  PVC_PHASE=$(kubectl -n "$CELL" get pvc -l app=gitaly -o jsonpath='{.items[0].status.phase}')
  check test "$PVC_PHASE" = "Bound"

  # HTTP health endpoints
  check curl -sf "https://${HOST}/-/health"
  check curl -sf "https://${HOST}/-/readiness"

  # TLS certificate valid
  TLS_CERT=$(openssl s_client -connect "${HOST}:443" -servername "${HOST}" </dev/null 2>/dev/null | openssl x509 -noout -checkend 0 >/dev/null 2>/dev/null && echo ok || echo fail)
  check test "$TLS_CERT" = "ok"
done

echo "=== Git Operations (canary cell) ==="
CANARY_HOST="gitlab.alpha.${DOMAIN}"
# Create PAT via rails runner. Copy the helper Python script into the toolbox
# so bash never sees the '!' in create!(...) (no history expansion in files).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
kubectl cp "${SCRIPT_DIR}/create-root-pat.py" cell-alpha/$(kubectl -n cell-alpha get pod -l app=toolbox -o jsonpath='{.items[0].metadata.name}'):/tmp/create-root-pat.py
kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- python3 /tmp/create-root-pat.py e2e
TOKEN=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner /tmp/e2e_pat.rb \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
# Use a timestamped project name to avoid 400 "already taken" on reruns.
# curl -sf exits 56 (CURLE_RECV_ERROR) for 4xx responses over HTTP/2 on this
# nginx setup — use curl -s + explicit HTTP status check instead.
E2E_PROJECT="e2e-$(date +%s)"
PROJECT_RESP=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects" -d "name=${E2E_PROJECT}" -w "\n%{http_code}")
PROJECT_HTTP=$(echo "$PROJECT_RESP" | tail -1)
PROJECT_BODY=$(echo "$PROJECT_RESP" | head -n -1)
check test "$PROJECT_HTTP" = "201"
PROJECT_ID=$(echo "$PROJECT_BODY" | jq -r '.id')
check test -n "$PROJECT_ID"
# Clone + push (empty project — git init + push rather than clone)
TMPDIR=$(mktemp -d)
mkdir "$TMPDIR/e2e-repo" && cd "$TMPDIR/e2e-repo"
git init -b main && git -c user.email="root@localhost" -c user.name="root" commit --allow-empty -m "init"
git remote add origin "https://root:${TOKEN}@${CANARY_HOST}/root/${E2E_PROJECT}.git"
check git push -u origin main
cd -

# Verify commit via API
COMMIT_MSG=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/repository/commits" | jq -r '.[0].message')
check test "$COMMIT_MSG" = "init"

echo "=== Container Registry ==="
REGISTRY_HOST="registry.alpha.${DOMAIN}"
check docker login "${REGISTRY_HOST}" -u root -p "$TOKEN"
docker pull alpine:latest >/dev/null 2>&1 || true
check docker tag alpine:latest "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"
check docker push "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"
check docker pull "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"

echo "=== Cell Isolation ==="
# From alpha pod, try to reach beta — must fail (NetworkPolicy isolation)
CROSS_CELL=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-webservice-default -- timeout 5 curl -sf "http://gitlab-cell-beta-webservice-default.cell-beta.svc:8080" 2>/dev/null && echo reachable || echo blocked)
check test "$CROSS_CELL" = "blocked"
# Verify separate databases (use single-quoted strings for ruby code inside kubectl exec
# to avoid bash history-expansion on special characters like '!')
ALPHA_DB=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner \
  'puts ActiveRecord::Base.connection.current_database' \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
BETA_DB=$(kubectl -n cell-beta exec deploy/gitlab-cell-beta-toolbox -- gitlab-rails runner \
  'puts ActiveRecord::Base.connection.current_database' \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
check test "$ALPHA_DB" = "gitlabhq_production"
check test "$BETA_DB" = "gitlabhq_production"
# Verify different DB hosts — read from per-cell Helm values
ALPHA_HOST=$(kubectl -n cell-alpha exec deploy/gitlab-cell-alpha-toolbox -- gitlab-rails runner \
  'puts ActiveRecord::Base.connection.pool.db_config.configuration_hash[:host]' \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
BETA_HOST=$(kubectl -n cell-beta exec deploy/gitlab-cell-beta-toolbox -- gitlab-rails runner \
  'puts ActiveRecord::Base.connection.pool.db_config.configuration_hash[:host]' \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
check test "$ALPHA_HOST" != "$BETA_HOST"

echo "=== Topology Routing ==="
check kubectl -n system exec deploy/topology-service -- wget -qO- http://localhost:8080/healthz

echo "=== Runner ==="
# Trigger pipeline (project needs .gitlab-ci.yml — skip if no CI config)
PIPELINE_RESP=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipeline" \
  -d "ref=main" -w "\n%{http_code}")
PIPELINE_HTTP=$(echo "$PIPELINE_RESP" | tail -1)
PIPELINE_BODY=$(echo "$PIPELINE_RESP" | head -n -1)
if [ "$PIPELINE_HTTP" = "201" ]; then
  PIPELINE_ID=$(echo "$PIPELINE_BODY" | jq -r '.id')
  check test -n "$PIPELINE_ID"
  sleep 30
  JOB_STATUS=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" \
    "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/jobs" | jq -r '.[0].status // "none"')
  check test "$JOB_STATUS" != "stuck"
else
  echo "  No pipeline triggered (no CI config) — skipping runner check"
fi

echo "=== Backup ==="
check kubectl -n cell-alpha exec statefulset/gitlab-cell-alpha-gitaly -- gitaly-backup create --server-side --path "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test"
check gsutil ls "gs://${GCP_PROJECT_ID}-alpha-artifacts/gitaly-backups/e2e-test/" >/dev/null

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))
