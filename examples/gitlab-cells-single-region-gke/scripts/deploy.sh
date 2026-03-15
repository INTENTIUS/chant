#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

CELLS="${CELLS:-$(bun -e "import { cells } from './src/config.ts'; process.stdout.write(cells.map(c => c.name).join(' '))")}"

echo "================================================================"
echo "  GitLab Cells — Full Deploy"
echo "================================================================"

# ── Phase 0: Build + push Docker images ──────────────────────────────
if [ "${SKIP_BUILD_IMAGES:-false}" != "true" ]; then
  echo ""
  echo "Phase 0: Building and pushing images..."
  bash scripts/build-images.sh
fi

# ── Phase 1: Build all lexicons ──────────────────────────────────────
echo ""
echo "Phase 1: Building all lexicons..."
npm run build

# ── Phase 2: Configure kubectl ───────────────────────────────────────
echo ""
echo "Phase 2: Configuring kubectl..."
npm run configure-kubectl

# ── Phase 3: Apply Config Connector infra (VPC, SQL, Redis, KMS, IAM) ──
echo ""
echo "Phase 3: Applying Config Connector infrastructure..."
kubectl apply -f config.yaml

# ── Phase 4: Wait for Cloud SQL instances ────────────────────────────
echo ""
echo "Phase 4: Waiting for Cloud SQL instances (up to 10 min each)..."
for CELL in $CELLS; do
  echo "  Waiting for gitlab-${CELL}-db..."
  kubectl wait sqlinstances "gitlab-${CELL}-db" \
    --for=condition=Ready --timeout=600s
done
# Also wait for topology DB
echo "  Waiting for gitlab-topology-db..."
kubectl wait sqlinstances "gitlab-topology-db" \
  --for=condition=Ready --timeout=600s

# ── Phase 5: Wait for Redis instances ────────────────────────────────
echo ""
echo "Phase 5: Waiting for Redis instances (up to 10 min each)..."
for CELL in $CELLS; do
  echo "  Waiting for gitlab-${CELL}-persistent..."
  kubectl wait redisinstances "gitlab-${CELL}-persistent" \
    --for=condition=Ready --timeout=600s
  echo "  Waiting for gitlab-${CELL}-cache..."
  kubectl wait redisinstances "gitlab-${CELL}-cache" \
    --for=condition=Ready --timeout=600s
done

# ── Phase 6: Load outputs + initialize secrets ───────────────────────
echo ""
echo "Phase 6: Loading outputs and initializing secrets..."
bash scripts/load-outputs.sh
set -a; source .env; set +a  # pick up TOPOLOGY_DB_HOST written by load-outputs.sh

# Rebuild k8s.yaml now that TOPOLOGY_DB_HOST is resolved — topology-service
# ConfigMap gets the real DB host baked in; no post-apply patch needed.
echo "  Rebuilding k8s.yaml with resolved TOPOLOGY_DB_HOST=${TOPOLOGY_DB_HOST}..."
npm run build:k8s

echo "  Rebuilding gitlab-cell/ values with resolved IPs..."
npm run build:helm

# ── Phase 7: Apply K8s system resources + wait for LB ────────────────
echo ""
echo "Phase 7: Applying system K8s resources..."
kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system

echo "  Waiting for NGINX ingress LoadBalancer IP..."
until kubectl -n system get svc ingress-nginx-controller \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null | grep -q '^[0-9]'; do
  sleep 10
  echo "  still waiting for LB IP..."
done
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "  Ingress IP: ${INGRESS_IP}"

# Persist ingress IP (replace existing line or append)
if grep -q '^INGRESS_IP=' .env; then
  sed -i.bak "s/^INGRESS_IP=.*/INGRESS_IP=${INGRESS_IP}/" .env && rm -f .env.bak
else
  echo "INGRESS_IP=${INGRESS_IP}" >> .env
fi

# ── Phase 8: Apply K8s cell resources ────────────────────────────────
echo ""
echo "Phase 8: Applying cell K8s resources..."
kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=cells

echo "  Waiting for ExternalSecrets to sync..."
sleep 30  # give ESO time to start reconciling
for CELL in $CELLS; do
  NS="cell-${CELL}"
  for SECRET in gitlab-db-password gitlab-redis-password gitlab-root-password gitlab-rails-secret; do
    echo "  Waiting for ExternalSecret ${SECRET} in ${NS}..."
    kubectl -n "$NS" wait externalsecrets "$SECRET" \
      --for=condition=Ready --timeout=120s
  done
done

# ── Phase 9: Deploy GitLab Helm releases ─────────────────────────────
echo ""
echo "Phase 9: Deploying GitLab cell Helm releases..."
bash scripts/deploy-cells.sh

echo ""
echo "================================================================"
echo "  Deploy complete!"
echo "  User-facing URL:  https://${DOMAIN}"
echo "  Ingress IP:       ${INGRESS_IP}"
echo "  Grafana:          http://localhost:3000  (kubectl port-forward deploy/grafana 3000:3000 -n system)"
echo "  Grafana password: gcloud secrets versions access latest --secret=gitlab-grafana-admin-password --project=${GCP_PROJECT_ID}"
for CELL in $CELLS; do
  echo "  Cell ${CELL} admin:  https://${CELL}.${DOMAIN}"
done
echo "================================================================"
