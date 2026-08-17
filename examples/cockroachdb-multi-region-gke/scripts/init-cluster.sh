#!/usr/bin/env bash
# Wait for the declared init Job, then create the daily backup schedule.
#
# `cockroach init` itself is NOT run here. CockroachDbCluster declares an init
# Job for the primary region, and that Job mounts the CLIENT certs — which is
# the part that matters: the node certs secret contains ca.crt, node.crt and
# node.key and no client certificate at all, so `cockroach init` or
# `cockroach sql` run inside a database pod against /cockroach/cockroach-certs
# falls through to password auth and fails with
#
#   ERROR: password authentication failed for user root
#
# which reads like a credentials problem and is really a certs-dir problem.
# East mounts the client certs separately (mountClientCerts), and every
# statement below uses that directory.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
ctx="${CRDB_CONTEXT:-east}"
ns="${CRDB_NAMESPACE:-crdb-east}"
client_certs="/cockroach/cockroach-client-certs"

echo "==> waiting for the init Job"
kubectl --context "${ctx}" -n "${ns}" wait --for=condition=complete \
  job/cockroachdb-init --timeout=600s

echo "==> daily backup schedule"
kubectl --context "${ctx}" exec cockroachdb-0 -n "${ns}" -- \
  /cockroach/cockroach sql --certs-dir="${client_certs}" -e "
CREATE SCHEDULE IF NOT EXISTS 'daily-full-backup'
  FOR BACKUP INTO 'gs://${project_id}-crdb-backups/full?AUTH=implicit'
  RECURRING '@daily'
  WITH SCHEDULE OPTIONS first_run = 'now';
"
