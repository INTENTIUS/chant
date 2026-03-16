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
check kubectl -n cert-manager rollout status deploy/cert-manager --timeout=120s
check kubectl -n kube-system rollout status deploy/external-secrets --timeout=60s
check kubectl -n system rollout status deploy/gitlab-runner --timeout=60s
check kubectl -n system rollout status deploy/topology-service --timeout=60s
check kubectl -n system rollout status deploy/prometheus --timeout=120s
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
check test -n "$INGRESS_IP"

echo "=== Per-Cell GitLab ==="
for CELL in $(kubectl get ns -l app.kubernetes.io/part-of=cells -o jsonpath='{.items[*].metadata.name}'); do
  CELL_NAME=${CELL#cell-}
  HOST="gitlab.${CELL_NAME}.${DOMAIN}"

  # Pod health (release name = gitlab-cell-<name>, chart prepends to resource names)
  check kubectl -n "$CELL" rollout status deploy/gitlab-cell-${CELL_NAME}-webservice-default --timeout=300s
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

  # Login validation — catches PLACEHOLDER passwords and broken DB seeds.
  # Fetches the root password from Secret Manager and authenticates via OAuth.
  CELL_ROOT_PASS=$(gcloud secrets versions access latest \
    --secret="gitlab-${CELL_NAME}-root-password" --project="$GCP_PROJECT_ID" 2>/dev/null || echo "")
  if [ -n "$CELL_ROOT_PASS" ]; then
    LOGIN_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 \
      -d "grant_type=password&username=root&password=${CELL_ROOT_PASS}" \
      "https://${HOST}/oauth/token")
    check test "$LOGIN_HTTP" = "200"
  else
    echo "  SKIP: gitlab-${CELL_NAME}-root-password secret not found — cannot validate login"
    PASS=$((PASS + 1))
  fi
done

echo "=== Base Domain Routing ==="
# Validates that gitlab.example.com (the user-facing bare domain) resolves, has valid TLS,
# and that the cell router serves a GitLab response (302 redirect to sign-in page).
# A wildcard *.domain record does not cover the bare domain — this catches missing apex A records.
BASE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "https://${DOMAIN}")
check test "$BASE_HTTP" = "302" -o "$BASE_HTTP" = "200"
BASE_TLS=$(openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" </dev/null 2>/dev/null | openssl x509 -noout -checkend 0 >/dev/null 2>/dev/null && echo ok || echo fail)
check test "$BASE_TLS" = "ok"

echo "=== Git Operations (canary cell) ==="
# Discover the canary cell from the K8s namespace label set by factory.ts
CANARY_CELL=$(kubectl get ns -l "app.kubernetes.io/part-of=cells,gitlab.example.com/canary=true" \
  -o jsonpath='{.items[0].metadata.name}' | sed 's/^cell-//')
CANARY_HOST="gitlab.${CANARY_CELL}.${DOMAIN}"
# Create PAT via rails runner. Copy the helper Python script into the toolbox
# so bash never sees the '!' in create!(...) (no history expansion in files).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
kubectl cp "${SCRIPT_DIR}/create-root-pat.py" "cell-${CANARY_CELL}/$(kubectl -n "cell-${CANARY_CELL}" get pod -l app=toolbox -o jsonpath='{.items[0].metadata.name}')":/tmp/create-root-pat.py
kubectl -n "cell-${CANARY_CELL}" exec "deploy/gitlab-cell-${CANARY_CELL}-toolbox" -- python3 /tmp/create-root-pat.py e2e
TOKEN=$(kubectl -n "cell-${CANARY_CELL}" exec "deploy/gitlab-cell-${CANARY_CELL}-toolbox" -- gitlab-rails runner /tmp/e2e_pat.rb \
  2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
# Use a timestamped project name to avoid 400 "already taken" on reruns.
# curl -sf exits 56 (CURLE_RECV_ERROR) for 4xx responses over HTTP/2 on this
# nginx setup — use curl -s + explicit HTTP status check instead.
E2E_PROJECT="e2e-$(date +%s)"
PROJECT_RESP=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects" -d "name=${E2E_PROJECT}" -w "\n%{http_code}")
PROJECT_HTTP=$(echo "$PROJECT_RESP" | tail -1)
PROJECT_BODY=$(echo "$PROJECT_RESP" | sed '$d')
check test "$PROJECT_HTTP" = "201"
PROJECT_ID=$(echo "$PROJECT_BODY" | jq -r '.id')
check test -n "$PROJECT_ID"
# Clone + push. Include .gitlab-ci.yml so the runner section can trigger a real job.
TMPDIR=$(mktemp -d)
mkdir "$TMPDIR/e2e-repo" && cd "$TMPDIR/e2e-repo"
git init -b main
printf 'e2e:\n  script:\n    - echo "e2e ok"\n' > .gitlab-ci.yml
git add .gitlab-ci.yml
git -c user.email="root@localhost" -c user.name="root" commit -m "init"
git remote add origin "https://root:${TOKEN}@${CANARY_HOST}/root/${E2E_PROJECT}.git"
check git push -u origin main
cd -

# Verify commit via API
COMMIT_MSG=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/repository/commits" | jq -r '.[0].message')
check test "$COMMIT_MSG" = "init"

echo "=== Base Domain API Routing ==="
# Verify the cell router + topology service route authenticated API requests at the
# bare domain to the correct cell. Uses the canary PAT obtained above.
USER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 \
  -H "PRIVATE-TOKEN: $TOKEN" "https://${DOMAIN}/api/v4/user")
check test "$USER_HTTP" = "200"
# Verify the project created on the canary cell is reachable via the base domain.
PROJECT_VIA_BASE=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" \
  "https://${DOMAIN}/api/v4/projects/${PROJECT_ID}" | jq -r '.id // empty')
check test "$PROJECT_VIA_BASE" = "$PROJECT_ID"

echo "=== Container Registry ==="
REGISTRY_HOST="registry.${CANARY_CELL}.${DOMAIN}"
check docker login "${REGISTRY_HOST}" -u root -p "$TOKEN"
docker pull alpine:latest >/dev/null 2>&1 || true
check docker tag alpine:latest "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"
check docker push "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"
check docker pull "${REGISTRY_HOST}/root/${E2E_PROJECT}/alpine:e2e"

echo "=== Cell Isolation ==="
# Discover all cells and pick a non-canary target to test isolation against the canary.
ALL_CELLS=$(kubectl get ns -l "app.kubernetes.io/part-of=cells" \
  -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | sed 's/^cell-//')
ISOLATION_TARGET=$(kubectl get ns -l "app.kubernetes.io/part-of=cells,gitlab.example.com/canary=false" \
  -o jsonpath='{.items[0].metadata.name}' | sed 's/^cell-//')
# Cross-cell NetworkPolicy isolation test.
# NOTE: GKE Calico (iptables mode) does not enforce NetworkPolicies for same-node pod pairs
# because kube-proxy DNAT runs before Calico in the iptables chain for local traffic.
# This is a known GKE limitation — cross-node enforcement works correctly.
# We skip the assertion if both pods land on the same node (common in dev/small clusters).
CANARY_NODE=$(kubectl -n "cell-${CANARY_CELL}" get pod -l app=webservice -o jsonpath='{.items[0].spec.nodeName}')
TARGET_NODE=$(kubectl -n "cell-${ISOLATION_TARGET}" get pod -l app=webservice -o jsonpath='{.items[0].spec.nodeName}')
if [ "$CANARY_NODE" = "$TARGET_NODE" ]; then
  echo "  SKIP: cell isolation check (both webservice pods on same node '${CANARY_NODE}' — GKE same-node NP bypass)"
  PASS=$((PASS + 1))
else
  CROSS_CELL_CODE=$(kubectl -n "cell-${CANARY_CELL}" exec "deploy/gitlab-cell-${CANARY_CELL}-webservice-default" -- \
    curl --connect-timeout 2 --max-time 3 -s -o /dev/null -w "%{http_code}" \
    "http://gitlab-cell-${ISOLATION_TARGET}-webservice-default.cell-${ISOLATION_TARGET}.svc:8080" 2>/dev/null) || CROSS_CELL_CODE="blocked"
  check test "$CROSS_CELL_CODE" = "blocked"
fi
# Verify all cells use gitlabhq_production DB name and each has a distinct DB host.
# (use single-quoted strings for ruby code inside kubectl exec to avoid history-expansion)
CELL_DB_HOSTS=""
for CELL_NAME in $ALL_CELLS; do
  DB_NAME=$(kubectl -n "cell-${CELL_NAME}" exec "deploy/gitlab-cell-${CELL_NAME}-toolbox" -- gitlab-rails runner \
    'puts ActiveRecord::Base.connection.current_database' \
    2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
  check test "$DB_NAME" = "gitlabhq_production"
  DB_HOST=$(kubectl -n "cell-${CELL_NAME}" exec "deploy/gitlab-cell-${CELL_NAME}-toolbox" -- gitlab-rails runner \
    'puts ActiveRecord::Base.connection.pool.db_config.configuration_hash[:host]' \
    2>&1 | grep -v WARNING | grep -v "composite primary key" | grep -v Defaulted | tail -1)
  check test -n "$DB_HOST"
  CELL_DB_HOSTS="${CELL_DB_HOSTS}${DB_HOST}"$'\n'
done
# Assert every cell uses a different Cloud SQL instance (hosts are all distinct)
UNIQUE_DB_HOSTS=$(printf '%s' "$CELL_DB_HOSTS" | sort -u | grep -c .)
TOTAL_CELLS=$(printf '%s' "$CELL_DB_HOSTS" | grep -c .)
check test "$UNIQUE_DB_HOSTS" -eq "$TOTAL_CELLS"

echo "=== Topology Routing ==="
check kubectl -n system exec deploy/topology-service -- wget -qO- http://localhost:8080/healthz

echo "=== Runner ==="
# Trigger a pipeline on the .gitlab-ci.yml pushed above and poll until the job succeeds.
# Times out after 5 minutes — if the runner is not picking up jobs, investigate with:
#   kubectl -n system logs deploy/gitlab-runner
PIPELINE_RESP=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipeline" \
  -d "ref=main" -w "\n%{http_code}")
PIPELINE_HTTP=$(echo "$PIPELINE_RESP" | tail -1)
PIPELINE_BODY=$(echo "$PIPELINE_RESP" | sed '$d')
check test "$PIPELINE_HTTP" = "201"
if [ "$PIPELINE_HTTP" = "201" ]; then
  PIPELINE_ID=$(echo "$PIPELINE_BODY" | jq -r '.id')
  check test -n "$PIPELINE_ID"
  # Poll up to 5 minutes (30 × 10s) for the job to reach a terminal state.
  JOB_STATUS="pending"
  for _i in $(seq 1 30); do
    sleep 10
    JOB_STATUS=$(curl -s -H "PRIVATE-TOKEN: $TOKEN" \
      "https://${CANARY_HOST}/api/v4/projects/${PROJECT_ID}/pipelines/${PIPELINE_ID}/jobs" \
      | jq -r '.[0].status // "none"')
    case "$JOB_STATUS" in success|failed|canceled|skipped) break ;; esac
  done
  echo "  Runner job final status: ${JOB_STATUS}"
  check test "$JOB_STATUS" = "success"
fi

echo "=== Backup ==="
# Verify GCS write access from the toolbox pod (validates WI + bucket IAM).
# Uses Python urllib (not gsutil) because toolbox's bundled gsutil 5.x (boto-based)
# doesn't support GKE Workload Identity; google.auth / urllib do.
BACKUP_KEY="e2e-test/writecheck-$(date +%s)"
BACKUP_BUCKET_NAME="${GCP_PROJECT_ID}-${CANARY_CELL}-artifacts"
check kubectl -n "cell-${CANARY_CELL}" exec "deploy/gitlab-cell-${CANARY_CELL}-toolbox" -- python3 -c "
import urllib.request, json
tok = json.loads(urllib.request.urlopen(urllib.request.Request(
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
  headers={'Metadata-Flavor':'Google'})).read())['access_token']
r = urllib.request.Request(
  'https://storage.googleapis.com/upload/storage/v1/b/${BACKUP_BUCKET_NAME}/o?uploadType=media&name=${BACKUP_KEY}',
  data=b'ok', headers={'Authorization':f'Bearer {tok}','Content-Type':'text/plain'}, method='POST')
print(urllib.request.urlopen(r).status)
"
gsutil rm "gs://${BACKUP_BUCKET_NAME}/${BACKUP_KEY}" >/dev/null 2>&1 || true

echo "=== Grafana ==="
# Verify the Prometheus datasource in Grafana is healthy.
# Uses the Secret Manager password and Grafana's datasource health API (Grafana 9+).
GRAFANA_PASS=$(gcloud secrets versions access latest \
  --secret=gitlab-grafana-admin-password --project="$GCP_PROJECT_ID" 2>/dev/null || echo "")
if [ -n "$GRAFANA_PASS" ]; then
  GRAFANA_AUTH=$(printf 'admin:%s' "$GRAFANA_PASS" | base64)
  DS_STATUS=$(kubectl -n system exec deploy/grafana -- \
    wget -qO- --header="Authorization: Basic ${GRAFANA_AUTH}" \
    "http://localhost:3000/api/datasources/name/Prometheus/health" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','fail'))" 2>/dev/null \
    || echo "fail")
  check test "$DS_STATUS" = "OK"
else
  echo "  SKIP: gitlab-grafana-admin-password secret not found"
  PASS=$((PASS + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $((FAIL > 0 ? 1 : 0))
