#!/usr/bin/env bash
# Configure CockroachDB multi-region topology after cluster init.
# Sets primary region, adds secondary regions, configures survival goal,
# and creates a demo REGIONAL BY ROW table.
set -euo pipefail

echo "==> Configuring CockroachDB multi-region topology"

CRDB_SQL="kubectl --context east exec cockroachdb-0 -n crdb-east -- /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs -e"

echo "  -> Setting primary region to us-east4"
${CRDB_SQL} "ALTER DATABASE defaultdb SET PRIMARY REGION 'us-east4';"

echo "  -> Adding region us-central1"
${CRDB_SQL} "ALTER DATABASE defaultdb ADD REGION 'us-central1';"

echo "  -> Adding region us-west1"
${CRDB_SQL} "ALTER DATABASE defaultdb ADD REGION 'us-west1';"

echo "  -> Setting survival goal to REGION"
${CRDB_SQL} "ALTER DATABASE defaultdb SURVIVE REGION FAILURE;"

echo "  -> Creating demo REGIONAL BY ROW table"
${CRDB_SQL} "
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region crdb_internal_region NOT NULL DEFAULT gateway_region()::crdb_internal_region,
  customer_id UUID NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_customer (customer_id)
) LOCALITY REGIONAL BY ROW;
"

echo "  -> Inserting sample rows from each region"
${CRDB_SQL} "INSERT INTO orders (customer_id, total) VALUES ('11111111-1111-1111-1111-111111111111', 99.99);"

kubectl --context central exec cockroachdb-0 -n crdb-central -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs -e \
  "INSERT INTO orders (customer_id, total) VALUES ('22222222-2222-2222-2222-222222222222', 149.99);"

kubectl --context west exec cockroachdb-0 -n crdb-west -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs -e \
  "INSERT INTO orders (customer_id, total) VALUES ('33333333-3333-3333-3333-333333333333', 79.99);"

echo "==> Multi-region topology configured"
echo "    Run 'SHOW REGIONS FROM DATABASE defaultdb;' to verify"
echo "    Run 'SELECT * FROM orders;' to see rows from all regions"
echo "    Run 'SHOW SCHEDULES;' to verify backup schedule"
