#!/usr/bin/env bash
# Prove the local cluster is a cluster: three live nodes, three regions known
# to SQL, and a REGIONAL BY ROW table that accepts a write.
#
# This is the assertion the smoke test exists for. Anything short of it —
# pods Running, StatefulSets rolled out — is satisfied by three CockroachDB
# nodes that never found each other.
set -euo pipefail

ctx="${K3D_CONTEXT:?Set K3D_CONTEXT}"
# The CLIENT certs directory, not the node one: the node certs secret has no
# client certificate, so `cockroach sql` against it falls through to password
# auth and fails with "password authentication failed for user root". East
# mounts the client certs (mountClientCerts in k3d/src/regions.ts).
certs="/cockroach/cockroach-client-certs"
sql=(kubectl --context "${ctx}" exec cockroachdb-0 -n crdb-east --
     /cockroach/cockroach sql --certs-dir="${certs}")

echo "==> node status"
kubectl --context "${ctx}" exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach node status --certs-dir="${certs}"

live=$(kubectl --context "${ctx}" exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir="${certs}" \
  --format=csv -e "SELECT count(*) FROM crdb_internal.gossip_liveness WHERE NOT decommissioning;" \
  | tail -1 | tr -d '[:space:]')

if [[ "${live}" != "3" ]]; then
  echo "  [FAIL] expected 3 live nodes, got '${live}'"
  echo "  Nodes that never joined usually mean gossip could not resolve the"
  echo "  advertise addresses — check advertiseHostDomain against the headless"
  echo "  service names."
  exit 1
fi
echo "  [PASS] 3 live nodes"

echo "==> multi-region topology"
"${sql[@]}" -e "ALTER DATABASE defaultdb SET PRIMARY REGION 'us-east4';"
"${sql[@]}" -e "ALTER DATABASE defaultdb ADD REGION 'us-central1';"
"${sql[@]}" -e "ALTER DATABASE defaultdb ADD REGION 'us-west1';"
"${sql[@]}" -e "SHOW REGIONS FROM DATABASE defaultdb;"

regions=$("${sql[@]}" --format=csv -e \
  "SELECT count(*) FROM [SHOW REGIONS FROM DATABASE defaultdb];" | tail -1 | tr -d '[:space:]')
if [[ "${regions}" != "3" ]]; then
  echo "  [FAIL] expected 3 database regions, got '${regions}'"
  exit 1
fi
echo "  [PASS] 3 database regions"

echo "==> REGIONAL BY ROW table accepts a write"
"${sql[@]}" -e "
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region crdb_internal_region NOT NULL DEFAULT gateway_region()::crdb_internal_region,
  total DECIMAL(10,2) NOT NULL
) LOCALITY REGIONAL BY ROW;
INSERT INTO orders (total) VALUES (99.99);
SELECT region, count(*) FROM orders GROUP BY region;
"
echo "  [PASS] regional-by-row write"

echo ""
echo "Smoke test PASSED — 3 nodes, 3 regions, one logical cluster."
