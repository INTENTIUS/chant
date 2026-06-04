#!/usr/bin/env bash
# argo-cd-gke — end-to-end on-ramp.
#
# Demonstrates the split: Chant authors manifests, Argo CD reconciles them.
# Prereqs: gcloud + kubectl authenticated, GCP_PROJECT_ID set, and the built
# workload (dist/app/) pushed to the git repo referenced by ARGO_REPO.
set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
CLUSTER="${GKE_CLUSTER_NAME:-argo-demo}"
REGION="${GCP_REGION:-us-central1}"

echo "==> Building manifests"
npm run build

echo "==> Creating GKE Autopilot cluster '$CLUSTER' (if absent)"
gcloud container clusters describe "$CLUSTER" --region "$REGION" --project "$GCP_PROJECT_ID" >/dev/null 2>&1 \
  || npm run cluster

echo "==> Configuring kubectl"
npm run configure-kubectl

echo "==> Installing Argo CD"
npm run install-argocd

echo "==> Bootstrapping the Application (Chant-authored, via ArgoAppFor)"
echo "    Argo will sync dist/app/ from: ${ARGO_REPO:-<set ARGO_REPO>}"
npm run bootstrap

echo "==> Waiting for the Application to become Healthy"
npm run wait

echo "==> Done. The workload is reconciled by Argo CD:"
npm run status
echo
echo "Open the Argo UI with:  npm run ui   (then https://localhost:8080)"
echo "Initial admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
