#!/usr/bin/env bash
# Deploy CockroachDB multi-region GKE cluster: 3 regions in one GCP VPC.
#
# Requires a management cluster with Config Connector (run `npm run bootstrap` first).
# Config Connector creates all GCP infra via kubectl apply, then we deploy
# K8s manifests to the 3 workload clusters.
#
# Phases:
#   1. Build all stacks
#   2. kubectl apply shared infra (VPC, subnets, NAT, private DNS zone)
#   3. kubectl apply regional infra (3 GKE clusters + IAM + public DNS zones)
#      Wait for ContainerCluster resources to be Ready; delete default node pools
#   4. Get credentials for 3 workload clusters, rename contexts
#   5. Generate and distribute TLS certs
#   6. Install External Secrets Operator
#   7. Push TLS certs to Secret Manager
#   8. Apply K8s manifests to each workload cluster
#   9. Wait for ExternalDNS pod IP registration
#  10. Wait for StatefulSets
#  11. Run cockroach init
#  12. Configure multi-region topology
#  13. Create daily backup schedule
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> Pre-flight: checking required environment variables"
_missing=0
for var in GCP_PROJECT_ID CRDB_DOMAIN; do
  if [[ -z "${!var:-}" ]]; then
    echo "  [ERROR] ${var} is not set"
    _missing=1
  fi
done
if [[ ${_missing} -eq 1 ]]; then
  echo "  Copy .env.example to .env, fill in values, and source it: set -a && source .env && set +a"
  exit 1
fi

echo "==> Pre-flight: checking required tools"
for cmd in gcloud kubectl docker helm; do
  if ! command -v "${cmd}" &>/dev/null; then
    echo "  [ERROR] ${cmd} is not installed or not in PATH"
    _missing=1
  fi
done
if [[ ${_missing} -eq 1 ]]; then
  echo "  Install missing tools before deploying. See README.md Prerequisites."
  exit 1
fi

echo "==> Pre-flight: verifying management cluster context"
if ! kubectl get crd containerclusters.container.cnrm.cloud.google.com &>/dev/null; then
  echo "  [ERROR] Config Connector CRDs not found. Run 'npm run bootstrap' first."
  exit 1
fi

echo "==> Step 1: Build all stacks"
npm run build

echo "==> Step 2: Deploy shared infrastructure (VPC, subnets, NAT, private DNS)"
kubectl apply -f dist/shared-infra.yaml

echo "==> Step 3: Deploy regional infrastructure (3 GKE clusters + IAM + DNS zones)"
kubectl apply -f dist/east-infra.yaml
kubectl apply -f dist/central-infra.yaml
kubectl apply -f dist/west-infra.yaml

echo "  Waiting for Config Connector to reconcile GKE clusters (this takes ~10-15 min)..."
kubectl wait --for=condition=Ready containercluster/gke-crdb-east containercluster/gke-crdb-central containercluster/gke-crdb-west --timeout=900s
echo "  All 3 GKE clusters are Ready."

echo "  Waiting for IAM policy bindings to be Ready..."
kubectl wait --for=condition=Ready iampolicymember -l app.kubernetes.io/managed-by=chant --timeout=120s 2>/dev/null || true

echo "  Waiting for managed node pools to be RUNNING before deleting default pools..."
for _pool_info in "gke-crdb-east:us-east4" "gke-crdb-central:us-central1" "gke-crdb-west:us-west1"; do
  _pool_cluster="${_pool_info%%:*}"
  _pool_region="${_pool_info#*:}"
  for _pi in $(seq 1 60); do
    _pool_status=$(gcloud container node-pools describe "${_pool_cluster}-nodes" \
      --cluster "${_pool_cluster}" --region "${_pool_region}" --project "${GCP_PROJECT_ID}" \
      --format="value(status)" 2>/dev/null) || true
    if [[ "${_pool_status}" == "RUNNING" ]]; then
      echo "  ${_pool_cluster}-nodes is RUNNING"
      break
    fi
    echo "  ${_pool_cluster}-nodes: ${_pool_status:-not found} (${_pi}/60)"
    sleep 15
  done
  echo "  Deleting default-pool from ${_pool_cluster} to free CPU quota..."
  gcloud container node-pools delete default-pool \
    --cluster "${_pool_cluster}" --region "${_pool_region}" \
    --project "${GCP_PROJECT_ID}" --quiet 2>/dev/null || true
done

echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │ REMINDER: If this is your first deploy, you need to delegate   │"
echo "  │ DNS subdomains at your registrar after infra is up.            │"
echo "  │ See README.md → 'DNS Delegation (One-Time Setup)'             │"
echo "  │ This is only needed for public UI access, not cluster health.  │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""

echo "==> Step 4: Configure kubectl contexts for workload clusters"
gcloud container clusters get-credentials gke-crdb-east --region us-east4 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" east 2>/dev/null || true

gcloud container clusters get-credentials gke-crdb-central --region us-central1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" central 2>/dev/null || true

gcloud container clusters get-credentials gke-crdb-west --region us-west1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" west 2>/dev/null || true

echo "==> Step 5: Generate and distribute TLS certificates"
bash scripts/generate-certs.sh

echo "==> Step 6: Install External Secrets Operator on all workload clusters"
helm repo add external-secrets https://charts.external-secrets.io 2>/dev/null || true
helm repo update external-secrets
for ctx in east central west; do
  echo "  -> Installing ESO on ${ctx}..."
  helm upgrade --install external-secrets external-secrets/external-secrets \
    --kube-context "${ctx}" \
    --namespace kube-system \
    --set installCRDs=true \
    --wait --timeout 120s
done

echo "==> Step 7: Push TLS certificates to Secret Manager"
CERTS_DIR="${CERTS_DIR:-./certs}"
gcloud secrets versions add crdb-ca-crt --data-file="${CERTS_DIR}/ca.crt" --project "${GCP_PROJECT_ID}" 2>/dev/null || true
gcloud secrets versions add crdb-node-crt --data-file="${CERTS_DIR}/node.crt" --project "${GCP_PROJECT_ID}" 2>/dev/null || true
gcloud secrets versions add crdb-node-key --data-file="${CERTS_DIR}/node.key" --project "${GCP_PROJECT_ID}" 2>/dev/null || true
gcloud secrets versions add crdb-client-root-crt --data-file="${CERTS_DIR}/client.root.crt" --project "${GCP_PROJECT_ID}" 2>/dev/null || true
gcloud secrets versions add crdb-client-root-key --data-file="${CERTS_DIR}/client.root.key" --project "${GCP_PROJECT_ID}" 2>/dev/null || true
echo "  Certificates pushed to Secret Manager"

echo "==> Step 8: Apply K8s manifests (parallel)"
(
  kubectl --context east apply -f dist/east-k8s.yaml &
  kubectl --context central apply -f dist/central-k8s.yaml &
  kubectl --context west apply -f dist/west-k8s.yaml &
  wait
)

echo "==> Step 9: Wait for ExternalDNS to register pod IPs in crdb.internal"
echo "  Checking ExternalDNS pods are running..."
for ctx in east central west; do
  kubectl --context "${ctx}" -n kube-system rollout status deployment/external-dns --timeout=120s
done

echo "  Waiting for DNS records in crdb.internal private zone..."
for i in $(seq 1 30); do
  _record_count=$(gcloud dns record-sets list --zone=crdb-internal \
    --project "${GCP_PROJECT_ID}" \
    --filter="type=A" \
    --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${_record_count}" -ge 3 ]]; then
    echo "  DNS records registered (${_record_count} A records found)"
    break
  fi
  echo "  A records found: ${_record_count} — waiting... (${i}/30)"
  sleep 10
done

if [[ "${_record_count}" -lt 3 ]]; then
  echo "  [WARN] Expected at least 3 A record sets in crdb.internal but found ${_record_count}."
  echo "  Check ExternalDNS logs: kubectl --context east -n kube-system logs -l app.kubernetes.io/name=external-dns"
  echo "  Continuing — StatefulSets may take longer to become ready."
fi

echo "==> Step 10: Wait for StatefulSets to be ready"
kubectl --context east -n crdb-east rollout status statefulset/cockroachdb --timeout=300s
kubectl --context central -n crdb-central rollout status statefulset/cockroachdb --timeout=300s
kubectl --context west -n crdb-west rollout status statefulset/cockroachdb --timeout=300s

echo "==> Step 11: Initialize CockroachDB cluster"
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach init --certs-dir=/cockroach/cockroach-certs

echo "==> Step 12: Configure multi-region topology"
bash scripts/configure-regions.sh

echo "==> Step 13: Create daily backup schedule"
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs -e "
CREATE SCHEDULE IF NOT EXISTS 'daily-full-backup'
  FOR BACKUP INTO 'gs://${GCP_PROJECT_ID}-crdb-backups/full?AUTH=implicit'
  RECURRING '@daily'
  WITH SCHEDULE OPTIONS first_run = 'now';
"
echo "  Backup schedule created"

_domain="${CRDB_DOMAIN:-crdb.example.com}"
echo "==> CockroachDB multi-region GKE cluster is ready!"
echo "    East UI:    https://east.${_domain}"
echo "    Central UI: https://central.${_domain}"
echo "    West UI:    https://west.${_domain}"
echo ""
echo "    SQL:  kubectl --context east exec -it cockroachdb-0 -n crdb-east -- \\"
echo "          /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs"
