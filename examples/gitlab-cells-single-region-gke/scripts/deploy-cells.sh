#!/usr/bin/env bash
set -euo pipefail

set -a; source .env; set +a

# Deploy canary cells first
for VALUES_FILE in values-alpha.yaml values-beta.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  IS_CANARY=$(kubectl get ns "cell-${CELL}" -o jsonpath='{.metadata.labels.gitlab\.example\.com/canary}' 2>/dev/null || echo "false")
  if [ "$IS_CANARY" = "true" ]; then
    echo "Deploying canary cell: ${CELL}"
    helm upgrade --install "gitlab-cell-${CELL}" gitlab/gitlab \
      --version "${GITLAB_CHART_VERSION:-8.7.2}" \
      -n "cell-${CELL}" -f gitlab-cell/values-base.yaml -f "$VALUES_FILE" --wait --timeout=900s
    kubectl -n "cell-${CELL}" rollout status "deploy/gitlab-cell-${CELL}-webservice-default" --timeout=300s
    echo "Canary cell ${CELL} deployed successfully"
  fi
done

# Deploy remaining cells
for VALUES_FILE in values-alpha.yaml values-beta.yaml; do
  CELL=$(basename "$VALUES_FILE" .yaml | sed 's/values-//')
  IS_CANARY=$(kubectl get ns "cell-${CELL}" -o jsonpath='{.metadata.labels.gitlab\.example\.com/canary}' 2>/dev/null || echo "false")
  if [ "$IS_CANARY" != "true" ]; then
    echo "Deploying cell: ${CELL}"
    helm upgrade --install "gitlab-cell-${CELL}" gitlab/gitlab \
      --version "${GITLAB_CHART_VERSION:-8.7.2}" \
      -n "cell-${CELL}" -f gitlab-cell/values-base.yaml -f "$VALUES_FILE" --wait --timeout=900s
    kubectl -n "cell-${CELL}" rollout status "deploy/gitlab-cell-${CELL}-webservice-default" --timeout=300s
    echo "Cell ${CELL} deployed successfully"
  fi
done

echo "All cells deployed."
