#!/usr/bin/env bash
# Block until ExternalDNS has registered pod addresses in the crdb.internal
# private zone. Nine nodes gossip over these names; a StatefulSet that starts
# before they resolve spends its join attempts on NXDOMAIN and then backs off
# for a long time.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
expected="${EXPECTED_A_RECORDS:-3}"
attempts="${DNS_WAIT_ATTEMPTS:-30}"

for i in $(seq 1 "${attempts}"); do
  count=$(gcloud dns record-sets list --zone=crdb-internal \
    --project "${project_id}" --filter="type=A" \
    --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${count}" -ge "${expected}" ]]; then
    echo "==> ${count} A record sets registered in crdb.internal"
    exit 0
  fi
  echo "  ${count}/${expected} A record sets (${i}/${attempts})"
  sleep 10
done

echo "  [ERROR] crdb.internal still has fewer than ${expected} A record sets."
echo "  kubectl --context east -n kube-system logs -l app.kubernetes.io/name=external-dns"
exit 1
