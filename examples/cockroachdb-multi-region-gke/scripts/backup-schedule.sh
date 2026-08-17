#!/usr/bin/env bash
# Create the daily backup schedule against the shared GCS bucket.
#
# Runs after the nodes are ready, because it execs into one. Waiting for the
# init Job is the deploy Op's Initialize phase, not this script's job — that
# wait is a declared readiness spec on the Job's own Complete/Failed
# conditions, which fails fast on a Job that will never finish.
#
# `cockroach sql` uses the CLIENT certs directory. The node certs secret holds
# ca.crt, node.crt and node.key and no client certificate, so the node certs
# directory falls through to password auth and fails with "password
# authentication failed for user root" — which reads like a credentials
# problem and is not. Only east mounts the client certs.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
ctx="${CRDB_CONTEXT:-east}"
ns="${CRDB_NAMESPACE:-crdb-east}"
client_certs="/cockroach/cockroach-client-certs"

echo "==> daily backup schedule"
kubectl --context "${ctx}" exec cockroachdb-0 -n "${ns}" -- \
  /cockroach/cockroach sql --certs-dir="${client_certs}" -e "
CREATE SCHEDULE IF NOT EXISTS 'daily-full-backup'
  FOR BACKUP INTO 'gs://${project_id}-crdb-backups/full?AUTH=implicit'
  RECURRING '@daily'
  WITH SCHEDULE OPTIONS first_run = 'now';
"
