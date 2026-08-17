#!/usr/bin/env bash
# Turn nine nodes that know about each other into a multi-region database:
# a primary region, two secondaries, and a survival goal that means the cluster
# keeps serving when a whole region goes.
#
# Every statement runs from east against the CLIENT certs directory. The node
# certs secret has no client certificate in it, so `--certs-dir=/cockroach/
# cockroach-certs` falls through to password auth and fails — see
# scripts/init-cluster.sh.
set -euo pipefail

ctx="${CRDB_CONTEXT:-east}"
ns="${CRDB_NAMESPACE:-crdb-east}"
client_certs="/cockroach/cockroach-client-certs"

sql() {
  kubectl --context "${ctx}" exec cockroachdb-0 -n "${ns}" -- \
    /cockroach/cockroach sql --certs-dir="${client_certs}" -e "$1"
}

echo "==> primary region us-east4"
sql "ALTER DATABASE defaultdb SET PRIMARY REGION 'us-east4';"

echo "==> adding us-central1 and us-west1"
sql "ALTER DATABASE defaultdb ADD REGION 'us-central1';"
sql "ALTER DATABASE defaultdb ADD REGION 'us-west1';"

# The reason the cluster spans three regions at all. Under REGION survival a
# whole region can fail without the database losing quorum — which needs
# replicas in all three, so it is only legal once all three are added.
echo "==> survive region failure"
sql "ALTER DATABASE defaultdb SURVIVE REGION FAILURE;"

# Rows carry their own region and are homed there, so a read from the region
# that owns the row is local. This is the payoff of the whole topology.
echo "==> demo REGIONAL BY ROW table"
sql "
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region crdb_internal_region NOT NULL DEFAULT gateway_region()::crdb_internal_region,
  customer_id UUID NOT NULL,
  total DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_customer (customer_id)
) LOCALITY REGIONAL BY ROW;
"

# One row per region, written through each region's own gateway so the default
# gateway_region() puts it where it belongs. Central and west run the insert
# themselves; they hold no client cert, so the statement goes in over the SQL
# service from east with an explicit region instead.
echo "==> sample rows"
sql "
INSERT INTO orders (region, customer_id, total) VALUES
  ('us-east4',    '11111111-1111-1111-1111-111111111111',  99.99),
  ('us-central1', '22222222-2222-2222-2222-222222222222', 149.99),
  ('us-west1',    '33333333-3333-3333-3333-333333333333',  79.99);
"

echo ""
echo "  SHOW REGIONS FROM DATABASE defaultdb;   -- three regions"
echo "  SELECT region, count(*) FROM orders GROUP BY region;"
echo "  SHOW SCHEDULES;                          -- the daily backup"
