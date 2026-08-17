#!/usr/bin/env bash
# Push the generated TLS material into the Secret Manager entries the shared
# stack declared. The secrets themselves are chant resources; their VERSIONS
# are payload, which synthesis has no business carrying.
#
# External Secrets then syncs them into each cluster.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
certs_dir="${CERTS_DIR:-./certs}"

add_version() {
  local secret="$1" file="$2"
  if [[ ! -f "${certs_dir}/${file}" ]]; then
    echo "  [ERROR] ${certs_dir}/${file} not found — run scripts/generate-certs.sh first"
    exit 1
  fi
  echo "==> ${secret} <- ${file}"
  gcloud secrets versions add "${secret}" \
    --data-file="${certs_dir}/${file}" --project "${project_id}"
}

add_version crdb-ca-crt          ca.crt
add_version crdb-node-crt        node.crt
add_version crdb-node-key        node.key
add_version crdb-client-root-crt client.root.crt
add_version crdb-client-root-key client.root.key
