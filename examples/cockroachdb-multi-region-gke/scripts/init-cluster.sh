#!/usr/bin/env bash
# Initialise the CockroachDB cluster from east — once, for all nine nodes —
# and create the daily backup schedule against the shared GCS bucket.
#
# Idempotent: `cockroach init` on an already-initialised cluster is a no-op
# error, and the schedule is created IF NOT EXISTS.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
crdb=(kubectl --context east exec cockroachdb-0 -n crdb-east --
      /cockroach/cockroach)

echo "==> cockroach init"
if ! "${crdb[@]}" init --certs-dir=/cockroach/cockroach-certs 2>&1; then
  echo "  already initialised — continuing"
fi

echo "==> daily backup schedule"
"${crdb[@]}" sql --certs-dir=/cockroach/cockroach-certs -e "
CREATE SCHEDULE IF NOT EXISTS 'daily-full-backup'
  FOR BACKUP INTO 'gs://${project_id}-crdb-backups/full?AUTH=implicit'
  RECURRING '@daily'
  WITH SCHEDULE OPTIONS first_run = 'now';
"
