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
  PG_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}')
  REPLICA_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db-replica-0" -o jsonpath='{.status.ipAddresses[?(@.type=="PRIVATE")].ipAddress}' 2>/dev/null || echo "")

  # Read Redis hosts
  REDIS_PERSISTENT=$(kubectl get redisinstances "gitlab-${CELL}-persistent" -o jsonpath='{.status.host}')
  REDIS_CACHE=$(kubectl get redisinstances "gitlab-${CELL}-cache" -o jsonpath='{.status.host}')

  # Read Cloud SQL password from CC-generated K8s secret and push to Secret Manager
  PG_PASSWORD=$(kubectl get secret "gitlab-${CELL}-db-sql-instance-credentials" -o jsonpath='{.data.password}' | base64 -d)
  echo -n "$PG_PASSWORD" | gcloud secrets versions add "gitlab-${CELL}-db-password" --data-file=- --project "$GCP_PROJECT_ID"

  # Generate per-cell values file
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
  echo "Generated values-${CELL}.yaml"
done

# Read ingress IP (may not be available until after system namespace deploy)
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PENDING")
echo "INGRESS_IP=${INGRESS_IP}" >> .env
echo "Ingress IP: ${INGRESS_IP}"
