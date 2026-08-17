#!/usr/bin/env bash
# Generate one CA and one node cert for the local three-node cluster, and put
# them in all three namespaces.
#
# The same shape as the GKE path (scripts/generate-certs.sh) minus the GCP:
# one CA for everybody, one node cert whose SANs cover every name any node
# advertises, one root client cert. On GKE these travel through Secret Manager
# and External Secrets; here they go straight in as K8s Secrets, because the
# operator that would sync them is the one piece of GKE this smoke test does
# not stand up.
#
# The `secure: true` path in CockroachDbCluster is what this exercises: a
# per-region cert-gen Job would mint three different CAs and nothing would
# trust anything, which is why the declarations set skipCertGen.
set -euo pipefail

ctx="${K3D_CONTEXT:?Set K3D_CONTEXT — the Op passes the context k3dUp resolved}"
certs_dir="${CERTS_DIR:-./k3d/certs}"
image="${CRDB_IMAGE:-cockroachdb/cockroach:v24.3.0}"

rm -rf "${certs_dir}"
mkdir -p "${certs_dir}"
abs_certs="$(cd "${certs_dir}" && pwd)"

echo "==> CA"
docker run --rm -v "${abs_certs}:/certs" "${image}" \
  cert create-ca --certs-dir=/certs --ca-key=/certs/ca.key

echo "==> node cert covering all three namespaces"
docker run --rm -v "${abs_certs}:/certs" "${image}" \
  cert create-node \
    cockroachdb-0.cockroachdb.crdb-east.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-central.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-west.svc.cluster.local \
    cockroachdb-0.cockroachdb \
    cockroachdb-public \
    cockroachdb-public.crdb-east \
    cockroachdb-public.crdb-central \
    cockroachdb-public.crdb-west \
    localhost 127.0.0.1 \
    --certs-dir=/certs --ca-key=/certs/ca.key

echo "==> root client cert"
docker run --rm -v "${abs_certs}:/certs" "${image}" \
  cert create-client root --certs-dir=/certs --ca-key=/certs/ca.key

for region in east central west; do
  ns="crdb-${region}"
  echo "==> secrets in ${ns}"
  kubectl --context "${ctx}" create namespace "${ns}" \
    --dry-run=client -o yaml | kubectl --context "${ctx}" apply -f -

  kubectl --context "${ctx}" -n "${ns}" create secret generic cockroachdb-node-certs \
    --from-file=ca.crt="${certs_dir}/ca.crt" \
    --from-file=node.crt="${certs_dir}/node.crt" \
    --from-file=node.key="${certs_dir}/node.key" \
    --dry-run=client -o yaml | kubectl --context "${ctx}" apply -f -

  kubectl --context "${ctx}" -n "${ns}" create secret generic cockroachdb-client-certs \
    --from-file=ca.crt="${certs_dir}/ca.crt" \
    --from-file=client.root.crt="${certs_dir}/client.root.crt" \
    --from-file=client.root.key="${certs_dir}/client.root.key" \
    --dry-run=client -o yaml | kubectl --context "${ctx}" apply -f -
done
