#!/usr/bin/env bash
# Deploy CockroachDB multi-region GKE cluster: 3 regions in one GCP VPC.
#
# True single-pass deploy (no rebuild step):
#   1. Build all stacks
#   2. Deploy shared infra (VPC, subnets, NAT, private DNS zone)
#   3. Deploy regional infra in parallel (3 GKE clusters + IAM + public DNS zones)
#   4. Configure kubectl contexts
#   5. Generate and distribute TLS certs
#   6. Apply K8s manifests in parallel
#   7. Wait for ExternalDNS + StatefulSets
#   8. Run cockroach init
#   9. Configure multi-region topology
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
for cmd in gcloud kubectl docker; do
  if ! command -v "${cmd}" &>/dev/null; then
    echo "  [ERROR] ${cmd} is not installed or not in PATH"
    _missing=1
  fi
done
if [[ ${_missing} -eq 1 ]]; then
  echo "  Install missing tools before deploying. See README.md Prerequisites."
  exit 1
fi

echo "==> Step 1: Build all stacks"
npm run build

echo "==> Step 2: Deploy shared infrastructure (VPC, subnets, NAT, private DNS)"
gcloud deployment-manager deployments create crdb-shared \
  --config dist/shared-infra.yaml \
  --project "${GCP_PROJECT_ID}" 2>/dev/null || \
gcloud deployment-manager deployments update crdb-shared \
  --config dist/shared-infra.yaml \
  --project "${GCP_PROJECT_ID}"

echo "==> Step 3: Deploy regional infrastructure (parallel)"
(
  (gcloud deployment-manager deployments create crdb-east \
    --config dist/east-infra.yaml \
    --project "${GCP_PROJECT_ID}" 2>/dev/null || \
  gcloud deployment-manager deployments update crdb-east \
    --config dist/east-infra.yaml \
    --project "${GCP_PROJECT_ID}") &

  (gcloud deployment-manager deployments create crdb-central \
    --config dist/central-infra.yaml \
    --project "${GCP_PROJECT_ID}" 2>/dev/null || \
  gcloud deployment-manager deployments update crdb-central \
    --config dist/central-infra.yaml \
    --project "${GCP_PROJECT_ID}") &

  (gcloud deployment-manager deployments create crdb-west \
    --config dist/west-infra.yaml \
    --project "${GCP_PROJECT_ID}" 2>/dev/null || \
  gcloud deployment-manager deployments update crdb-west \
    --config dist/west-infra.yaml \
    --project "${GCP_PROJECT_ID}") &

  wait
)

echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │ REMINDER: If this is your first deploy, you need to delegate   │"
echo "  │ DNS subdomains at your registrar after infra is up.            │"
echo "  │ See README.md → 'DNS Delegation (One-Time Setup)'             │"
echo "  │ This is only needed for public UI access, not cluster health.  │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""

echo "==> Step 4: Configure kubectl contexts"
gcloud container clusters get-credentials gke-crdb-east --region us-east4 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" east 2>/dev/null || true

gcloud container clusters get-credentials gke-crdb-central --region us-central1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" central 2>/dev/null || true

gcloud container clusters get-credentials gke-crdb-west --region us-west1 --project "${GCP_PROJECT_ID}"
kubectl config rename-context "$(kubectl config current-context)" west 2>/dev/null || true

echo "==> Step 5: Generate and distribute TLS certificates"
bash scripts/generate-certs.sh

echo "==> Step 6: Apply K8s manifests (parallel)"
(
  kubectl --context east apply -f dist/east-k8s.yaml &
  kubectl --context central apply -f dist/central-k8s.yaml &
  kubectl --context west apply -f dist/west-k8s.yaml &
  wait
)

echo "==> Step 7: Wait for ExternalDNS to register pod IPs in crdb.internal"
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

echo "==> Step 8: Wait for StatefulSets to be ready"
kubectl --context east -n crdb-east rollout status statefulset/cockroachdb --timeout=300s
kubectl --context central -n crdb-central rollout status statefulset/cockroachdb --timeout=300s
kubectl --context west -n crdb-west rollout status statefulset/cockroachdb --timeout=300s

echo "==> Step 9: Initialize CockroachDB cluster"
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach init --certs-dir=/cockroach/cockroach-certs

echo "==> Step 10: Configure multi-region topology"
bash scripts/configure-regions.sh

_domain="${CRDB_DOMAIN:-crdb.example.com}"
echo "==> CockroachDB multi-region GKE cluster is ready!"
echo "    East UI:    https://east.${_domain}"
echo "    Central UI: https://central.${_domain}"
echo "    West UI:    https://west.${_domain}"
echo ""
echo "    SQL:  kubectl --context east exec -it cockroachdb-0 -n crdb-east -- \\"
echo "          /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs"
