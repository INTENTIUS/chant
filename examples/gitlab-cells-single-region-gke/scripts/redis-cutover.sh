#!/usr/bin/env bash
# redis-cutover.sh — Migrate a GitLab cell's Redis from BASIC → STANDARD_HA tier.
#
# WHY THIS SCRIPT EXISTS:
#   Memorystore Redis tier changes are NOT in-place. You cannot upgrade a BASIC
#   instance to STANDARD_HA — you must create a new instance and redirect traffic.
#   This script handles the migration safely:
#     1. Drains Sidekiq to 0 replicas (stops queue processing, prevents data races)
#     2. Waits for in-flight jobs to complete
#     3. Prompts you to apply the new config (which creates the STANDARD_HA instance)
#     4. Waits for the new instance to be Ready
#     5. Updates the Helm release with the new Redis host
#     6. Restores Sidekiq replicas
#
# USAGE:
#   bash scripts/redis-cutover.sh --cell alpha --type persistent
#   bash scripts/redis-cutover.sh --cell alpha --type cache
#
# PREREQUISITES:
#   - kubectl context set to the GitLab Cells GKE cluster
#   - gcloud authenticated and GCP_PROJECT_ID exported
#   - config.ts already updated: redisPersistentTier or redisCacheTier → "STANDARD_HA"
#   - `npm run build` already run to regenerate dist/ YAML
#
# EXPECTED DOWNTIME: ~5-10 minutes (Sidekiq drained, helm upgrade in progress).
# GitLab web and API remain up throughout — only background jobs pause.
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────
CELL=""
REDIS_TYPE=""  # "persistent" or "cache"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cell) CELL="$2"; shift 2 ;;
    --type) REDIS_TYPE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -z "$CELL" || -z "$REDIS_TYPE" ]]; then
  echo "Usage: $0 --cell <cell-name> --type <persistent|cache>"
  exit 1
fi

if [[ "$REDIS_TYPE" != "persistent" && "$REDIS_TYPE" != "cache" ]]; then
  echo "ERROR: --type must be 'persistent' or 'cache'"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GCP_PROJECT="${GCP_PROJECT_ID:-}"
if [[ -z "$GCP_PROJECT" ]]; then
  echo "ERROR: GCP_PROJECT_ID not set"
  exit 1
fi

CELL_NS="cell-${CELL}"
HELM_RELEASE="gitlab-${CELL}"
GCP_REGION="${GCP_REGION:-us-central1}"

# Cloud SQL instance name convention (must match src/gcp/database.ts)
if [[ "$REDIS_TYPE" == "persistent" ]]; then
  REDIS_INSTANCE_NAME="gitlab-cell-${CELL}-redis"
  HELM_REDIS_KEY="global.redis.host"
  SIDEKIQ_SELECTOR="app.kubernetes.io/component=sidekiq"
else
  REDIS_INSTANCE_NAME="gitlab-cell-${CELL}-redis-cache"
  HELM_REDIS_KEY="global.redis.cache.host"
  SIDEKIQ_SELECTOR="app.kubernetes.io/component=sidekiq"
fi

echo "================================================================"
echo "Redis Cutover: ${CELL} / ${REDIS_TYPE}"
echo "  Instance: ${REDIS_INSTANCE_NAME}"
echo "  Namespace: ${CELL_NS}"
echo "  Helm release: ${HELM_RELEASE}"
echo "================================================================"
echo ""
echo "CAUTION: This script pauses Sidekiq for ~5-10 minutes."
echo "GitLab web, API, and git operations remain available."
echo ""
read -rp "Proceed? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Step 1: Record current Sidekiq replica counts ─────────────────────────────
echo ""
echo "=== Step 1: Recording current Sidekiq replica counts ==="

# Get all Sidekiq deployments in the cell namespace
SIDEKIQ_DEPLOYMENTS=$(kubectl -n "$CELL_NS" get deployments \
  -l "$SIDEKIQ_SELECTOR" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)

if [[ -z "$SIDEKIQ_DEPLOYMENTS" ]]; then
  # Fallback: look for any deployment with sidekiq in the name
  SIDEKIQ_DEPLOYMENTS=$(kubectl -n "$CELL_NS" get deployments \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | grep sidekiq || true)
fi

if [[ -z "$SIDEKIQ_DEPLOYMENTS" ]]; then
  echo "WARNING: No Sidekiq deployments found in namespace ${CELL_NS}."
  echo "Continuing without Sidekiq drain..."
  SIDEKIQ_DEPLOYMENTS=""
fi

declare -A ORIGINAL_REPLICAS
for deploy in $SIDEKIQ_DEPLOYMENTS; do
  REPLICAS=$(kubectl -n "$CELL_NS" get deployment "$deploy" \
    -o jsonpath='{.spec.replicas}')
  ORIGINAL_REPLICAS["$deploy"]="$REPLICAS"
  echo "  ${deploy}: ${REPLICAS} replicas"
done

# ── Step 2: Drain Sidekiq ────────────────────────────────────────────────────
echo ""
echo "=== Step 2: Draining Sidekiq (scale to 0) ==="
for deploy in $SIDEKIQ_DEPLOYMENTS; do
  echo "  Scaling ${deploy} to 0..."
  kubectl -n "$CELL_NS" scale deployment "$deploy" --replicas=0
done

# Wait for Sidekiq pods to terminate
if [[ -n "$SIDEKIQ_DEPLOYMENTS" ]]; then
  echo "Waiting for Sidekiq pods to terminate..."
  for i in $(seq 1 30); do
    RUNNING=$(kubectl -n "$CELL_NS" get pods -l "$SIDEKIQ_SELECTOR" \
      --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$RUNNING" == "0" ]]; then
      echo "  All Sidekiq pods terminated."
      break
    fi
    if [[ "$i" -eq 30 ]]; then
      echo "WARNING: Sidekiq pods still running after 60s. Proceeding anyway."
    fi
    echo "  ${RUNNING} pods still running... (${i}/30)"
    sleep 2
  done

  echo ""
  echo "Waiting 30s for in-flight jobs to complete..."
  sleep 30
fi

# ── Step 3: Apply new infrastructure config ──────────────────────────────────
echo ""
echo "=== Step 3: Apply updated infrastructure YAML ==="
echo ""
echo "  Ensure your config.ts has redisPersistentTier/redisCacheTier set to"
echo "  'STANDARD_HA' and you have run 'npm run build' to regenerate dist/."
echo ""
echo "  Run the following in a separate terminal, then return here:"
echo ""
echo "    kubectl apply -f ${ROOT_DIR}/dist/cell-${CELL}-infra.yaml"
echo ""
read -rp "  Press ENTER once kubectl apply has completed..."

# ── Step 4: Wait for new Redis instance to be Ready ─────────────────────────
echo ""
echo "=== Step 4: Waiting for new Redis instance to be Ready ==="
echo "  Instance: ${REDIS_INSTANCE_NAME} (STANDARD_HA can take 3-8 minutes)"

for i in $(seq 1 60); do
  STATE=$(gcloud redis instances describe "$REDIS_INSTANCE_NAME" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT" \
    --format="value(state)" 2>/dev/null || echo "NOT_FOUND")

  if [[ "$STATE" == "READY" ]]; then
    echo "  Redis instance is READY."
    break
  fi

  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: Redis instance not READY after 10 minutes. Check GCP console."
    echo "  Restoring Sidekiq replicas before exiting..."
    for deploy in $SIDEKIQ_DEPLOYMENTS; do
      kubectl -n "$CELL_NS" scale deployment "$deploy" \
        --replicas="${ORIGINAL_REPLICAS[$deploy]}"
    done
    exit 1
  fi

  echo "  State: ${STATE} (attempt ${i}/60, ~${i}0s elapsed)..."
  sleep 10
done

# ── Step 5: Get new Redis host ───────────────────────────────────────────────
echo ""
echo "=== Step 5: Fetching new Redis host ==="
NEW_REDIS_HOST=$(gcloud redis instances describe "$REDIS_INSTANCE_NAME" \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT" \
  --format="value(host)")

if [[ -z "$NEW_REDIS_HOST" ]]; then
  echo "ERROR: Could not get Redis host. Check: gcloud redis instances describe ${REDIS_INSTANCE_NAME}"
  exit 1
fi

echo "  New Redis host: ${NEW_REDIS_HOST}"

# ── Step 6: Update Helm release ──────────────────────────────────────────────
echo ""
echo "=== Step 6: Helm upgrade with new Redis host ==="
echo "  helm upgrade ${HELM_RELEASE} ... --set ${HELM_REDIS_KEY}=${NEW_REDIS_HOST}"
echo ""
echo "  Run the full helm upgrade command from the README (gitlab-cell chart),"
echo "  adding the following override:"
echo ""
echo "    --set ${HELM_REDIS_KEY}=${NEW_REDIS_HOST}"
echo ""
read -rp "  Press ENTER once helm upgrade has completed..."

# ── Step 7: Restore Sidekiq ──────────────────────────────────────────────────
echo ""
echo "=== Step 7: Restoring Sidekiq replicas ==="
for deploy in $SIDEKIQ_DEPLOYMENTS; do
  ORIG="${ORIGINAL_REPLICAS[$deploy]}"
  echo "  Scaling ${deploy} back to ${ORIG}..."
  kubectl -n "$CELL_NS" scale deployment "$deploy" --replicas="$ORIG"
done

# Wait for Sidekiq to be ready
if [[ -n "$SIDEKIQ_DEPLOYMENTS" ]]; then
  for deploy in $SIDEKIQ_DEPLOYMENTS; do
    kubectl -n "$CELL_NS" rollout status "deployment/${deploy}" --timeout=120s
  done
fi

echo ""
echo "================================================================"
echo "Redis cutover COMPLETE."
echo "  Cell:          ${CELL}"
echo "  Type:          ${REDIS_TYPE}"
echo "  New instance:  ${REDIS_INSTANCE_NAME} (STANDARD_HA)"
echo "  New host:      ${NEW_REDIS_HOST}"
echo ""
echo "Next steps:"
echo "  1. Monitor Sidekiq dashboard for queue depth returning to normal"
echo "  2. Update gitlab-cell/values-runtime-slots.yaml with new Redis host"
echo "  3. Verify the old BASIC instance was deleted (Config Connector handles this)"
echo "================================================================"
