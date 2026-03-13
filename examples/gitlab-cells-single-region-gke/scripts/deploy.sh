#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

CELLS="${CELLS:-alpha beta}"

echo "================================================================"
echo "  GitLab Cells — Full Deploy"
echo "================================================================"

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

# ── Phase 7: Install External Secrets Operator ───────────────────────
echo ""
echo "Phase 7: Installing External Secrets Operator..."
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm upgrade --install external-secrets external-secrets/external-secrets \
  -n kube-system \
  --set installCRDs=true \
  --wait --timeout=5m

# ── Phase 8: Install cert-manager ────────────────────────────────────
echo ""
echo "Phase 8: Installing cert-manager..."
helm repo add jetstack https://charts.jetstack.io --force-update
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true \
  --wait --timeout=5m

# ── Phase 9: Apply K8s system resources + wait for LB ────────────────
echo ""
echo "Phase 9: Applying system K8s resources..."
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
  sed -i '' "s/^INGRESS_IP=.*/INGRESS_IP=${INGRESS_IP}/" .env
else
  echo "INGRESS_IP=${INGRESS_IP}" >> .env
fi

echo "  Patching topology-service ConfigMap with real DB host..."
kubectl -n system patch configmap topology-service --type merge -p \
  "{\"data\":{\"config.yaml\":\"database:\\n  host: ${TOPOLOGY_DB_HOST}\\n  port: 5432\\n  name: topology_production\\n  sslmode: require\\nserver:\\n  port: 8080\\n\"}}"
kubectl -n system rollout restart deployment/topology-service

# ── Phase 10: Apply K8s cell resources ───────────────────────────────
echo ""
echo "Phase 10: Applying cell K8s resources..."
kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=cells

echo "  Waiting for ExternalSecrets to sync..."
sleep 30  # give ESO time to start reconciling
for CELL in $CELLS; do
  NS="cell-${CELL}"
  for SECRET in gitlab-db-password gitlab-redis-password gitlab-root-password gitlab-rails-secret; do
    echo "  Waiting for ExternalSecret ${SECRET} in ${NS}..."
    kubectl -n "$NS" wait externalsecrets "$SECRET" \
      --for=condition=Ready --timeout=120s 2>/dev/null || \
      echo "  Warning: ${SECRET} in ${NS} not Ready yet (continuing)"
  done
done

# ── Phase 11: Deploy GitLab Helm releases ────────────────────────────
echo ""
echo "Phase 11: Deploying GitLab cell Helm releases..."
bash scripts/deploy-cells.sh

echo ""
echo "================================================================"
echo "  Deploy complete!"
echo "  Ingress IP: ${INGRESS_IP}"
for CELL in $CELLS; do
  echo "  Cell ${CELL}: https://${CELL}.${DOMAIN}"
done
echo "================================================================"
