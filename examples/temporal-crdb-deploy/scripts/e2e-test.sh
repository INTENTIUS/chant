#!/usr/bin/env bash
# E2E validation for CockroachDB multi-region GKE deployment.
# Run after `npm run deploy` completes successfully.
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"
_fail=0

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; _fail=1; }

echo "==> Validating CockroachDB multi-region GKE deployment"

# ── KMS ──────────────────────────────────────────────────────────────
echo ""
echo "--- KMS ---"
if gcloud kms keys describe crdb-encryption \
  --keyring crdb-multi-region --location us \
  --project "${GCP_PROJECT_ID}" &>/dev/null; then
  pass "KMS crypto key crdb-encryption exists"
else
  fail "KMS crypto key crdb-encryption not found"
fi

# ── GCS Backup Bucket ───────────────────────────────────────────────
echo ""
echo "--- GCS Backup Bucket ---"
_bucket="${GCP_PROJECT_ID}-crdb-backups"
if gcloud storage buckets describe "gs://${_bucket}" --project "${GCP_PROJECT_ID}" &>/dev/null; then
  pass "GCS bucket ${_bucket} exists"
  _lifecycle=$(gcloud storage buckets describe "gs://${_bucket}" --format=json 2>/dev/null | grep -c "SetStorageClass\|Delete" || true)
  if [[ "${_lifecycle}" -ge 2 ]]; then
    pass "Lifecycle rules configured"
  else
    fail "Lifecycle rules missing or incomplete"
  fi
else
  fail "GCS bucket ${_bucket} not found"
fi

# ── Secret Manager ───────────────────────────────────────────────────
echo ""
echo "--- Secret Manager ---"
for secret in crdb-ca-crt crdb-node-crt crdb-node-key crdb-client-root-crt crdb-client-root-key; do
  if gcloud secrets versions list "${secret}" --project "${GCP_PROJECT_ID}" --limit=1 --format="value(name)" 2>/dev/null | grep -q .; then
    pass "Secret ${secret} has versions"
  else
    fail "Secret ${secret} missing or has no versions"
  fi
done

# ── Cloud Armor ──────────────────────────────────────────────────────
echo ""
echo "--- Cloud Armor ---"
if gcloud compute security-policies describe crdb-ui-waf --project "${GCP_PROJECT_ID}" &>/dev/null; then
  pass "Cloud Armor policy crdb-ui-waf exists"
else
  fail "Cloud Armor policy crdb-ui-waf not found"
fi

# ── Prometheus ───────────────────────────────────────────────────────
echo ""
echo "--- Prometheus ---"
for ctx in east central west; do
  ns="crdb-${ctx}"
  if kubectl --context "${ctx}" -n "${ns}" get deployment prometheus &>/dev/null; then
    _ready=$(kubectl --context "${ctx}" -n "${ns}" get deployment prometheus -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
    if [[ "${_ready}" -ge 1 ]]; then
      pass "Prometheus running in ${ctx} (${_ready} replica(s))"
    else
      fail "Prometheus not ready in ${ctx}"
    fi
  else
    fail "Prometheus deployment not found in ${ctx}"
  fi
done

# ── External Secrets Operator ────────────────────────────────────────
echo ""
echo "--- External Secrets Operator ---"
for ctx in east central west; do
  if kubectl --context "${ctx}" -n kube-system get deployment external-secrets &>/dev/null; then
    pass "ESO installed in ${ctx}"
  else
    fail "ESO not found in ${ctx}"
  fi
done

# ── Backup Schedule ──────────────────────────────────────────────────
echo ""
echo "--- Backup Schedule ---"
_schedules=$(kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs \
  -e "SELECT label FROM [SHOW SCHEDULES] WHERE label = 'daily-full-backup';" 2>/dev/null || echo "")
if echo "${_schedules}" | grep -q "daily-full-backup"; then
  pass "Backup schedule 'daily-full-backup' exists"
else
  fail "Backup schedule 'daily-full-backup' not found"
fi

# ── CockroachDB Cluster Health ───────────────────────────────────────
echo ""
echo "--- CockroachDB Cluster ---"
_node_count=$(kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach node status --certs-dir=/cockroach/cockroach-certs \
  --format=csv 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')
if [[ "${_node_count}" -ge 9 ]]; then
  pass "All ${_node_count} nodes healthy"
else
  fail "Expected 9 nodes, found ${_node_count}"
fi

# ── Multi-Region Topology ────────────────────────────────────────────
echo ""
echo "--- Multi-Region Topology ---"
_crdb_sql="kubectl --context east exec cockroachdb-0 -n crdb-east -- /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs --format=csv -e"

_region_count=$(${_crdb_sql} "SELECT count(*) FROM [SHOW REGIONS FROM DATABASE defaultdb];" 2>/dev/null | tail -1 | tr -d ' ')
if [[ "${_region_count}" -ge 3 ]]; then
  pass "Database has ${_region_count} regions configured"
else
  fail "Expected 3 regions, found ${_region_count}"
fi

_survival=$(${_crdb_sql} "SELECT survival_goal FROM [SHOW DATABASES] WHERE database_name = 'defaultdb';" 2>/dev/null | tail -1 | tr -d ' ')
if [[ "${_survival}" == "region" ]]; then
  pass "Survival goal is REGION"
else
  fail "Expected survival goal 'region', got '${_survival}'"
fi

_order_count=$(${_crdb_sql} "SELECT count(*) FROM orders;" 2>/dev/null | tail -1 | tr -d ' ')
if [[ "${_order_count}" -ge 3 ]]; then
  pass "Demo orders table has ${_order_count} rows"
else
  fail "Expected at least 3 rows in orders, found ${_order_count}"
fi

_region_distinct=$(${_crdb_sql} "SELECT count(DISTINCT region) FROM orders;" 2>/dev/null | tail -1 | tr -d ' ')
if [[ "${_region_distinct}" -ge 3 ]]; then
  pass "Orders span ${_region_distinct} distinct regions"
else
  fail "Expected orders in 3 regions, found ${_region_distinct}"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
if [[ ${_fail} -eq 0 ]]; then
  echo "==> All E2E checks passed"
else
  echo "==> Some E2E checks failed (see [FAIL] above)"
  exit 1
fi
