#!/usr/bin/env bash
# Fetch kubeconfig entries for the management cluster and the three workload
# clusters, and rename each context to the short name the Ops address it by:
# mgmt, east, central, west.
#
# Idempotent: re-running just refreshes the credentials.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"

rename_current() {
  local target="$1"
  local current
  current="$(kubectl config current-context)"
  [[ "${current}" == "${target}" ]] && return 0
  kubectl config delete-context "${target}" >/dev/null 2>&1 || true
  kubectl config rename-context "${current}" "${target}"
}

for entry in "gke-crdb-mgmt:us-central1:mgmt" \
             "gke-crdb-east:us-east4:east" \
             "gke-crdb-central:us-central1:central" \
             "gke-crdb-west:us-west1:west"; do
  cluster="${entry%%:*}"
  rest="${entry#*:}"
  region="${rest%%:*}"
  alias="${rest#*:}"

  echo "==> ${cluster} (${region}) -> context '${alias}'"
  gcloud container clusters get-credentials "${cluster}" \
    --region "${region}" --project "${project_id}"
  rename_current "${alias}"
done
