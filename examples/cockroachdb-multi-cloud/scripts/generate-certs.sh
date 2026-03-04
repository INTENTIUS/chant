#!/usr/bin/env bash
# Generate shared CA + node certs for all 9 CockroachDB nodes across 3 clusters.
# Run after all 3 K8s clusters are up but before applying K8s manifests.
set -euo pipefail

CERTS_DIR="${CERTS_DIR:-./certs}"
CRDB_IMAGE="${CRDB_IMAGE:-cockroachdb/cockroach:v24.3.0}"

echo "==> Generating CockroachDB certificates in ${CERTS_DIR}"
mkdir -p "${CERTS_DIR}"

# Generate CA cert
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-ca --certs-dir=/certs --ca-key=/certs/ca.key

# Generate ONE node cert with SANs for ALL 9 nodes + services across all 3 clusters.
# CockroachDB supports a single cert with many SANs — standard for multi-cloud StatefulSets.
echo "==> Generating node cert with all SANs"
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-node \
    cockroachdb-0.cockroachdb.crdb-eks.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-eks.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-eks.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-aks.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-aks.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-aks.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-gke.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-gke.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-gke.svc.cluster.local \
    cockroachdb-0.cockroachdb \
    cockroachdb-1.cockroachdb \
    cockroachdb-2.cockroachdb \
    cockroachdb-public \
    cockroachdb-public.crdb-eks \
    cockroachdb-public.crdb-aks \
    cockroachdb-public.crdb-gke \
    cockroachdb-public.crdb-eks.svc.cluster.local \
    cockroachdb-public.crdb-aks.svc.cluster.local \
    cockroachdb-public.crdb-gke.svc.cluster.local \
    localhost \
    127.0.0.1 \
    --certs-dir=/certs --ca-key=/certs/ca.key

# Generate client cert for root user
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-client root --certs-dir=/certs --ca-key=/certs/ca.key

echo "==> Creating K8s Secrets in all 3 clusters"
for cloud in eks aks gke; do
  ns="crdb-${cloud}"
  echo "  -> ${cloud}: creating secret in namespace ${ns}"

  # Ensure namespace exists
  kubectl --context "${cloud}" create namespace "${ns}" --dry-run=client -o yaml | \
    kubectl --context "${cloud}" apply -f -

  # Create node certs secret
  kubectl --context "${cloud}" -n "${ns}" create secret generic cockroachdb-node-certs \
    --from-file=ca.crt="${CERTS_DIR}/ca.crt" \
    --from-file=node.crt="${CERTS_DIR}/node.crt" \
    --from-file=node.key="${CERTS_DIR}/node.key" \
    --dry-run=client -o yaml | \
    kubectl --context "${cloud}" apply -f -

  # Create client certs secret (for cockroach init and SQL access)
  kubectl --context "${cloud}" -n "${ns}" create secret generic cockroachdb-client-certs \
    --from-file=ca.crt="${CERTS_DIR}/ca.crt" \
    --from-file=client.root.crt="${CERTS_DIR}/client.root.crt" \
    --from-file=client.root.key="${CERTS_DIR}/client.root.key" \
    --dry-run=client -o yaml | \
    kubectl --context "${cloud}" apply -f -
done

echo "==> Certificates generated and distributed to all 3 clusters"
