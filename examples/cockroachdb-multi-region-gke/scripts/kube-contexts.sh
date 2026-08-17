#!/usr/bin/env bash
# Fetch kubeconfig entries and rename each context to the short name the Ops
# address it by: mgmt, east, central, west.
#
#   kube-contexts.sh mgmt       the management cluster only
#   kube-contexts.sh workload   the three regional clusters only
#   kube-contexts.sh            all four
#
# The split is load-bearing, not tidiness. Every infra apply targets `mgmt`,
# starting with the deploy's first phase — but the three workload clusters do
# not exist until Config Connector has finished creating them, and this script
# runs under `set -euo pipefail`, so asking for their credentials before then
# kills the script and takes the mgmt context with it. `bootstrap.sh` leaves
# the context named `gke_<project>_us-central1_gke-crdb-mgmt`, which is not a
# name anything here uses.
#
# Idempotent: re-running just refreshes the credentials.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
scope="${1:-all}"

MGMT="gke-crdb-mgmt:us-central1:mgmt"
WORKLOAD=(
  "gke-crdb-east:us-east4:east"
  "gke-crdb-central:us-central1:central"
  "gke-crdb-west:us-west1:west"
)

case "${scope}" in
  mgmt)     targets=("${MGMT}") ;;
  workload) targets=("${WORKLOAD[@]}") ;;
  all)      targets=("${MGMT}" "${WORKLOAD[@]}") ;;
  *) echo "usage: $0 [mgmt|workload|all]" >&2; exit 1 ;;
esac

rename_current() {
  local target="$1"
  local current
  current="$(kubectl config current-context)"
  [[ "${current}" == "${target}" ]] && return 0
  kubectl config delete-context "${target}" >/dev/null 2>&1 || true
  kubectl config rename-context "${current}" "${target}"
}

for entry in "${targets[@]}"; do
  cluster="${entry%%:*}"
  rest="${entry#*:}"
  region="${rest%%:*}"
  alias="${rest#*:}"

  echo "==> ${cluster} (${region}) -> context '${alias}'"
  gcloud container clusters get-credentials "${cluster}" \
    --region "${region}" --project "${project_id}"
  rename_current "${alias}"
done
