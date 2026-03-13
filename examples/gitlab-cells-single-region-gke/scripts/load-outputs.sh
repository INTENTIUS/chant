#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

echo "Reading Config Connector outputs..."

# Cell list derived from Config Connector resources (not K8s namespaces —
# namespaces may not exist yet during first deploy). Pattern: all Cloud SQL
# instances named gitlab-<cell>-db.
CELLS=$(kubectl get sqlinstances -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | grep '^gitlab-.*-db$' | grep -v 'topology' | sed 's/^gitlab-//;s/-db$//')

# Cell identity mapping (from config.ts — static, not runtime state)
cell_id() {
  case "$1" in alpha) echo 1;; beta) echo 2;; *) echo 0;; esac
}
cell_offset() {
  case "$1" in alpha) echo 0;; beta) echo 1000000;; *) echo 0;; esac
}

for CELL in $CELLS; do
  echo "Processing cell: ${CELL}"

  PG_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db" -o jsonpath='{.status.privateIpAddress}')
  REPLICA_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db-replica-0" -o jsonpath='{.status.privateIpAddress}' 2>/dev/null || echo "")

  # Read Redis hosts
  REDIS_PERSISTENT=$(kubectl get redisinstances "gitlab-${CELL}-persistent" -o jsonpath='{.status.host}')
  REDIS_CACHE=$(kubectl get redisinstances "gitlab-${CELL}-cache" -o jsonpath='{.status.host}')

  # ── db-password ──────────────────────────────────────────────────────
  # Generate password if the K8s secret doesn't exist yet (CC SQLUser needs it pre-created)
  DB_SECRET_NAME="gitlab-${CELL}-db-db-password"
  if ! kubectl get secret "$DB_SECRET_NAME" -n default &>/dev/null; then
    PG_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)
    kubectl create secret generic "$DB_SECRET_NAME" \
      --from-literal=password="$PG_PASSWORD" -n default
    echo "  Created K8s secret $DB_SECRET_NAME"
  else
    PG_PASSWORD=$(kubectl get secret "$DB_SECRET_NAME" -o jsonpath='{.data.password}' | base64 -d)
  fi
  echo -n "$PG_PASSWORD" | gcloud secrets versions add "gitlab-${CELL}-db-password" --data-file=- --project "$GCP_PROJECT_ID"

  # ── redis-password (from CC status.authString) ────────────────────────
  REDIS_AUTH=$(kubectl get redisinstance "gitlab-${CELL}-persistent" \
    -o jsonpath='{.status.observedState.authString}' 2>/dev/null || echo "")
  if [ -z "$REDIS_AUTH" ]; then
    echo "  Warning: no Redis auth string found for ${CELL}-persistent; generating random"
    REDIS_AUTH=$(openssl rand -hex 16)
  fi
  echo -n "$REDIS_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-password" --data-file=- --project "$GCP_PROJECT_ID"

  # ── redis-cache-password ─────────────────────────────────────────────
  REDIS_CACHE_AUTH=$(kubectl get redisinstance "gitlab-${CELL}-cache" \
    -o jsonpath='{.status.observedState.authString}' 2>/dev/null || echo "")
  if [ -z "$REDIS_CACHE_AUTH" ]; then
    echo "  Warning: no Redis auth string found for ${CELL}-cache; generating random"
    REDIS_CACHE_AUTH=$(openssl rand -hex 16)
  fi
  echo -n "$REDIS_CACHE_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-cache-password" --data-file=- --project "$GCP_PROJECT_ID"

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

  # ── Object store connection secret (Workload Identity — no credentials file) ──
  if ! kubectl get secret gitlab-object-store-connection -n "cell-${CELL}" &>/dev/null; then
    kubectl create secret generic gitlab-object-store-connection \
      --from-literal=connection='{"provider":"Google","google_application_default":true}' \
      -n "cell-${CELL}"
    echo "  Created gitlab-object-store-connection in cell-${CELL}"
  fi

  # ── Generate per-cell values file (full nested Helm values) ──────────
  cat > "values-${CELL}.yaml" <<VALS
global:
  hosts:
    domain: "${CELL}.${DOMAIN}"
    https: true
  cells:
    id: $(cell_id "$CELL")
    sequence_offset: $(cell_offset "$CELL")
  psql:
    host: "${PG_IP}"
  redis:
    host: "${REDIS_PERSISTENT}"
    cache:
      host: "${REDIS_CACHE}"
    sharedState:
      host: "${REDIS_PERSISTENT}"
    queues:
      host: "${REDIS_PERSISTENT}"
    actioncable:
      host: "${REDIS_CACHE}"
  appConfig:
    object_store:
      connection:
        google_project: "${GCP_PROJECT_ID}"
    artifacts:
      bucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
    uploads:
      bucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
    lfs:
      bucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
    packages:
      bucket: "${GCP_PROJECT_ID}-${CELL}-artifacts"
VALS
  echo "  Generated values-${CELL}.yaml"
done

# ── Topology service DB host ──────────────────────────────────────────
TOPOLOGY_PG_IP=$(kubectl get sqlinstances "gitlab-topology-db" \
  -o jsonpath='{.status.privateIpAddress}' 2>/dev/null || echo "")
if [ -n "$TOPOLOGY_PG_IP" ]; then
  if grep -q '^TOPOLOGY_DB_HOST=' .env; then
    sed -i '' "s/^TOPOLOGY_DB_HOST=.*/TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}/" .env
  else
    echo "TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}" >> .env
  fi
  echo "Topology DB host: ${TOPOLOGY_PG_IP}"
fi

# ── Read ingress IP (may not be available until after system deploy) ──
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PENDING")
if grep -q '^INGRESS_IP=' .env; then
  sed -i '' "s/^INGRESS_IP=.*/INGRESS_IP=${INGRESS_IP}/" .env
else
  echo "INGRESS_IP=${INGRESS_IP}" >> .env
fi
echo "Ingress IP: ${INGRESS_IP}"
