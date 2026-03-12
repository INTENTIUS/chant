#!/usr/bin/env bash
set -euo pipefail

source .env

echo "Reading Config Connector outputs..."

# Cell list derived from Config Connector resources (not K8s namespaces —
# namespaces may not exist yet during first deploy). Pattern: all Cloud SQL
# instances named gitlab-<cell>-db.
CELLS=$(kubectl get sqlinstances -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | grep '^gitlab-.*-db$' | sed 's/^gitlab-//;s/-db$//')

# Cell identity mapping (from config.ts — static, not runtime state)
declare -A CELL_IDS=( ["alpha"]=1 ["beta"]=2 )
declare -A CELL_OFFSETS=( ["alpha"]=0 ["beta"]=1000000 )

for CELL in $CELLS; do
  echo "Processing cell: ${CELL}"

  PG_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}')
  REPLICA_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db-replica-0" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}' 2>/dev/null || echo "")

  # Read Redis hosts
  REDIS_PERSISTENT=$(kubectl get redisinstances "gitlab-${CELL}-persistent" -o jsonpath='{.status.host}')
  REDIS_CACHE=$(kubectl get redisinstances "gitlab-${CELL}-cache" -o jsonpath='{.status.host}')

  # ── db-password ──────────────────────────────────────────────────────
  PG_PASSWORD=$(kubectl get secret "gitlab-${CELL}-db-sql-instance-credentials" -o jsonpath='{.data.password}' | base64 -d)
  echo -n "$PG_PASSWORD" | gcloud secrets versions add "gitlab-${CELL}-db-password" --data-file=- --project "$GCP_PROJECT_ID"

  # ── redis-password (from CC-generated secret) ────────────────────────
  REDIS_AUTH=$(kubectl get secret "gitlab-${CELL}-persistent-redis-instance-credentials" \
    -o jsonpath='{.data.auth-string}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$REDIS_AUTH" ]; then
    echo -n "$REDIS_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-password" --data-file=- --project "$GCP_PROJECT_ID"
  else
    echo "  Warning: no Redis auth string found for ${CELL}-persistent; using empty password"
    echo -n "" | gcloud secrets versions add "gitlab-${CELL}-redis-password" --data-file=- --project "$GCP_PROJECT_ID"
  fi

  # ── redis-cache-password ─────────────────────────────────────────────
  REDIS_CACHE_AUTH=$(kubectl get secret "gitlab-${CELL}-cache-redis-instance-credentials" \
    -o jsonpath='{.data.auth-string}' 2>/dev/null | base64 -d || echo "")
  if [ -n "$REDIS_CACHE_AUTH" ]; then
    echo -n "$REDIS_CACHE_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-cache-password" --data-file=- --project "$GCP_PROJECT_ID"
  else
    echo -n "" | gcloud secrets versions add "gitlab-${CELL}-redis-cache-password" --data-file=- --project "$GCP_PROJECT_ID"
  fi

  # ── root-password (random, generated once) ───────────────────────────
  ROOT_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  echo -n "$ROOT_PASS" | gcloud secrets versions add "gitlab-${CELL}-root-password" --data-file=- --project "$GCP_PROJECT_ID"
  echo "  Cell ${CELL} root password: ${ROOT_PASS}  ← save this"

  # ── rails-secret ─────────────────────────────────────────────────────
  RAILS_SECRET=$(python3 - <<PYEOF
import secrets
lines = [
  "production:",
  "  secret_key_base: " + secrets.token_hex(64),
  "  db_key_base: " + secrets.token_hex(64),
  "  otp_key_base: " + secrets.token_hex(64),
  "  openid_connect_signing_key: ''",
]
print("\n".join(lines))
PYEOF
)
  echo -n "$RAILS_SECRET" | gcloud secrets versions add "gitlab-${CELL}-rails-secret" --data-file=- --project "$GCP_PROJECT_ID"

  # ── Generate per-cell values file ────────────────────────────────────
  cat > "values-${CELL}.yaml" <<VALS
cellDomain: "${CELL}.${DOMAIN}"
cellName: "${CELL}"
cellId: ${CELL_IDS[$CELL]:-0}
sequenceOffset: ${CELL_OFFSETS[$CELL]:-0}
pgHost: "${PG_IP}"
pgReadReplicaHost: "${REPLICA_IP}"
redisPersistentHost: "${REDIS_PERSISTENT}"
redisCacheHost: "${REDIS_CACHE}"
projectId: "${GCP_PROJECT_ID}"
artifactsBucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
registryBucket: "${GCP_PROJECT_ID}-${CELL}-registry"
smtpAddress: "${SMTP_ADDRESS}"
smtpPort: ${SMTP_PORT}
smtpUser: "${SMTP_USER}"
smtpDomain: "${SMTP_DOMAIN}"
VALS
  echo "  Generated values-${CELL}.yaml"
done

# ── Topology service DB host ──────────────────────────────────────────
TOPOLOGY_PG_IP=$(kubectl get sqlinstances "gitlab-topology-db" \
  -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}' 2>/dev/null || echo "")
if [ -n "$TOPOLOGY_PG_IP" ]; then
  if grep -q '^TOPOLOGY_DB_HOST=' .env; then
    sed -i "s/^TOPOLOGY_DB_HOST=.*/TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}/" .env
  else
    echo "TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}" >> .env
  fi
  echo "Topology DB host: ${TOPOLOGY_PG_IP}"
fi

# ── Read ingress IP (may not be available until after system deploy) ──
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PENDING")
if grep -q '^INGRESS_IP=' .env; then
  sed -i "s/^INGRESS_IP=.*/INGRESS_IP=${INGRESS_IP}/" .env
else
  echo "INGRESS_IP=${INGRESS_IP}" >> .env
fi
echo "Ingress IP: ${INGRESS_IP}"
