#!/usr/bin/env bash
# Register per-cell GitLab runners locally (mirrors the CI register-runners stage).
# Requires: kubectl configured for the gitlab-cells cluster.
set -euo pipefail

set -a; source .env; set +a

CELLS="${CELLS:-$(npx tsx --eval "import { cells } from './src/config.ts'; process.stdout.write(cells.map(c => c.name).join(' '))")}"

# cellId is the numeric routing prefix embedded in runner tokens (glrt-cell_<ID>_).
# Read from config.ts — no hardcoded mapping.
get_cell_id() {
  npx tsx --eval "import { cells } from './src/config.ts'; process.stdout.write(String(cells.find(c => c.name === '$1')?.cellId ?? 0))"
}

for CELL_NAME in $CELLS; do
  CELL_ID_VAL=$(get_cell_id "$CELL_NAME")
  NS="cell-${CELL_NAME}"

  echo "=== Registering runner for cell: ${CELL_NAME} (id=${CELL_ID_VAL}) ==="

  # Create a runner token via gitlab-rails inside the toolbox pod.
  # GitLab 17.x Cells generates tokens with prefix glrt-t{cellId}_ automatically when
  # the cell is configured with global.cells.enabled=true and global.cells.id=N.
  # token_prefix is not an AR attribute — the prefix is determined by the runner model internally.
  RUNNER_TOKEN=$(kubectl -n "$NS" exec "deploy/gitlab-cell-${CELL_NAME}-toolbox" -- \
    gitlab-rails runner \
    "puts Ci::Runner.create!(runner_type: :instance_type, registration_type: :authenticated_user).token")

  echo "  Token obtained. Storing as K8s secret..."
  kubectl -n "$NS" create secret generic "${CELL_NAME}-runner-token" \
    --from-literal="token=${RUNNER_TOKEN}" \
    --dry-run=client -o yaml | kubectl apply -f -

  echo "  Restarting runner deployment..."
  kubectl -n "$NS" rollout restart "deploy/${CELL_NAME}-runner"
  kubectl -n "$NS" rollout status "deploy/${CELL_NAME}-runner" --timeout=120s

  echo "  Runner registered for cell ${CELL_NAME}."
done

echo ""
echo "All runners registered."
