#!/usr/bin/env bash
# load-outputs.sh — Extract live GCP state and generate per-cell Helm values files.
#
# ⚠️  IDEMPOTENCY WARNING ⚠️
# This script is idempotent for Secret Manager entries: each secret is written
# ONCE and never overwritten on subsequent runs. This is intentional — rotating
# rails-secret invalidates ALL active GitLab sessions and OTP secrets.
#
# DO NOT re-run this script to "refresh" secrets. If you need to rotate a
# specific secret (e.g. after a security incident), use:
#   gcloud secrets versions add <secret-name> --data-file=- --project $GCP_PROJECT_ID
# and then restart the affected pods.
#
# Per-cell IP env vars (${CELL_UP}_DB_IP, etc.) are written to .env on every run;
# deploy.sh then runs `npm run build:helm` to generate gitlab-cell/values-<cell>.yaml.
set -euo pipefail

set -a; source .env; set +a

echo "Reading Config Connector outputs..."

# Cell list derived from Config Connector resources (not K8s namespaces —
# namespaces may not exist yet during first deploy). Pattern: all Cloud SQL
# instances named gitlab-<cell>-db.
CELLS=$(kubectl get sqlinstances -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n' | grep '^gitlab-.*-db$' | grep -v 'topology' | sed 's/^gitlab-//;s/-db$//')

# secret_has_version <secret-name>
# Returns 0 (true) if the secret already has at least one ENABLED version.
# Used to make secret generation idempotent — generate once, never rotate.
secret_has_version() {
  gcloud secrets versions list "$1" \
    --project "$GCP_PROJECT_ID" \
    --filter="state=ENABLED" \
    --limit=1 \
    --format="value(name)" 2>/dev/null | grep -q .
}

# Returns 0 (true) if the latest ENABLED version of a secret is exactly "PLACEHOLDER".
# Used to detect stale placeholder values written by a prior partial run.
secret_is_placeholder() {
  local VAL
  VAL=$(gcloud secrets versions access latest --secret="$1" --project "$GCP_PROJECT_ID" 2>/dev/null || echo "")
  [ "$VAL" = "PLACEHOLDER" ] || [ "$VAL" = "disabled" ]
}

for CELL in $CELLS; do
  echo "Processing cell: ${CELL}"

  PG_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db" -o jsonpath='{.status.privateIpAddress}')
  REPLICA_IP=$(kubectl get sqlinstances "gitlab-${CELL}-db-replica-0" -o jsonpath='{.status.privateIpAddress}' 2>/dev/null || echo "")

  # Read Redis hosts
  REDIS_PERSISTENT=$(kubectl get redisinstances "gitlab-${CELL}-persistent" -o jsonpath='{.status.host}')
  REDIS_CACHE=$(kubectl get redisinstances "gitlab-${CELL}-cache" -o jsonpath='{.status.host}')

  # ── db-password ──────────────────────────────────────────────────────
  # K8s secret is preserved across runs (CC SQLUser needs it pre-created).
  # Secret Manager version is written once and never rotated automatically.
  DB_SECRET_NAME="gitlab-${CELL}-db-db-password"
  if ! kubectl get secret "$DB_SECRET_NAME" -n default &>/dev/null; then
    PG_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)
    kubectl create secret generic "$DB_SECRET_NAME" \
      --from-literal=password="$PG_PASSWORD" -n default
    echo "  Created K8s secret $DB_SECRET_NAME"
  else
    PG_PASSWORD=$(kubectl get secret "$DB_SECRET_NAME" -o jsonpath='{.data.password}' | base64 -d)
  fi
  if secret_has_version "gitlab-${CELL}-db-password" && ! secret_is_placeholder "gitlab-${CELL}-db-password"; then
    echo "  gitlab-${CELL}-db-password already set — skipping"
  else
    echo -n "$PG_PASSWORD" | gcloud secrets versions add "gitlab-${CELL}-db-password" --data-file=- --project "$GCP_PROJECT_ID"
    echo "  gitlab-${CELL}-db-password stored in Secret Manager."
    # Also force-set the Cloud SQL user password — if a prior partial run left a stale Cloud SQL user
    # with a different password, Config Connector won't re-apply it (CC is idempotent). Reset explicitly.
    gcloud sql users set-password "gitlab-${CELL}-db-admin" \
      --instance="gitlab-${CELL}-db" \
      --password="$PG_PASSWORD" \
      --project "$GCP_PROJECT_ID" 2>/dev/null && echo "  gitlab-${CELL}-db-admin Cloud SQL password synced." || true
  fi

  # ── redis-password (from CC status.authString) ────────────────────────
  # Written once. If Redis is recreated (new authString), rotate manually.
  REDIS_AUTH=$(kubectl get redisinstance "gitlab-${CELL}-persistent" \
    -o jsonpath='{.status.observedState.authString}' 2>/dev/null || echo "")
  if [ -z "$REDIS_AUTH" ]; then
    echo "  Warning: no Redis auth string found for ${CELL}-persistent; generating random"
    REDIS_AUTH=$(openssl rand -hex 16)
  fi
  if secret_has_version "gitlab-${CELL}-redis-password" && ! secret_is_placeholder "gitlab-${CELL}-redis-password"; then
    echo "  gitlab-${CELL}-redis-password already set — skipping"
  else
    echo -n "$REDIS_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-password" --data-file=- --project "$GCP_PROJECT_ID"
    echo "  gitlab-${CELL}-redis-password stored in Secret Manager."
  fi

  # ── redis-cache-password ─────────────────────────────────────────────
  REDIS_CACHE_AUTH=$(kubectl get redisinstance "gitlab-${CELL}-cache" \
    -o jsonpath='{.status.observedState.authString}' 2>/dev/null || echo "")
  if [ -z "$REDIS_CACHE_AUTH" ]; then
    echo "  Warning: no Redis auth string found for ${CELL}-cache; generating random"
    REDIS_CACHE_AUTH=$(openssl rand -hex 16)
  fi
  if secret_has_version "gitlab-${CELL}-redis-cache-password" && ! secret_is_placeholder "gitlab-${CELL}-redis-cache-password"; then
    echo "  gitlab-${CELL}-redis-cache-password already set — skipping"
  else
    echo -n "$REDIS_CACHE_AUTH" | gcloud secrets versions add "gitlab-${CELL}-redis-cache-password" --data-file=- --project "$GCP_PROJECT_ID"
    echo "  gitlab-${CELL}-redis-cache-password stored in Secret Manager."
  fi

  # ── root-password (generated once — only read by GitLab at db:seed time) ──
  # Retrieve after deployment: gcloud secrets versions access latest --secret=gitlab-${CELL}-root-password
  if secret_has_version "gitlab-${CELL}-root-password"; then
    echo "  gitlab-${CELL}-root-password already set — skipping"
    echo "  To retrieve: gcloud secrets versions access latest --secret=gitlab-${CELL}-root-password --project \$GCP_PROJECT_ID"
  else
    ROOT_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
    echo -n "$ROOT_PASS" | gcloud secrets versions add "gitlab-${CELL}-root-password" --data-file=- --project "$GCP_PROJECT_ID"
    echo "  Cell ${CELL} root password stored in Secret Manager."
    echo "  Retrieve: gcloud secrets versions access latest --secret=gitlab-${CELL}-root-password --project \$GCP_PROJECT_ID"
  fi

  # ── rails-secret ─────────────────────────────────────────────────────
  # CRITICAL: generated once and never rotated. Rotating this secret invalidates
  # ALL active GitLab sessions, OTP (2FA) secrets, and signed tokens for this cell.
  # openid_connect_signing_key must be a real RSA private key — GitLab tries to write a
  # generated key to secrets.yml if the value is empty, which fails on a read-only volume.
  if secret_has_version "gitlab-${CELL}-rails-secret" && ! secret_is_placeholder "gitlab-${CELL}-rails-secret"; then
    echo "  gitlab-${CELL}-rails-secret already set — skipping (rotating would invalidate all sessions)"
  else
    OIDC_KEY=$(openssl genrsa 2048 2>/dev/null | python3 -c "import sys; print(repr(sys.stdin.read()))")
    RAILS_SECRET=$(python3 - <<PYEOF
import secrets
oidc_key = ${OIDC_KEY}
lines = [
  "production:",
  "  secret_key_base: " + secrets.token_hex(64),
  "  db_key_base: " + secrets.token_hex(64),
  "  otp_key_base: " + secrets.token_hex(64),
  "  openid_connect_signing_key: |",
] + ["    " + line for line in oidc_key.splitlines()]
print("\n".join(lines))
PYEOF
)
    echo -n "$RAILS_SECRET" | gcloud secrets versions add "gitlab-${CELL}-rails-secret" --data-file=- --project "$GCP_PROJECT_ID"
    echo "  gitlab-${CELL}-rails-secret stored."
  fi

  # ── Write per-cell IP env vars for chant helm build ──────────────────
  # load-outputs.sh writes resolved IPs to .env; deploy.sh runs `npm run build:helm`
  # afterwards, which generates gitlab-cell/values-<cell>.yaml from TypeScript.
  CELL_UP=$(echo "$CELL" | tr '[:lower:]' '[:upper:]')
  for PAIR in "${CELL_UP}_DB_IP=${PG_IP}" "${CELL_UP}_REDIS_PERSISTENT=${REDIS_PERSISTENT}" "${CELL_UP}_REDIS_CACHE=${REDIS_CACHE}"; do
    KEY="${PAIR%%=*}"
    VAL="${PAIR#*=}"
    if grep -q "^${KEY}=" .env; then
      sed -i.bak "s|^${KEY}=.*|${KEY}=${VAL}|" .env && rm -f .env.bak
    else
      echo "${KEY}=${VAL}" >> .env
    fi
  done
  echo "  Wrote per-cell IP env vars for ${CELL} to .env (values-${CELL}.yaml generated by npm run build:helm)"
done

# ── SMTP password (shared across all cells) ──────────────────────────
# Read from SMTP_PASSWORD env var. Set in .env before deploying.
# This secret is referenced by all cell ExternalSecrets (gitlab-smtp-password).
# If empty, a placeholder is stored and email delivery will be disabled in GitLab.
if secret_has_version "gitlab-smtp-password" && ! secret_is_placeholder "gitlab-smtp-password"; then
  echo "  gitlab-smtp-password already set — skipping"
else
  if [ -z "${SMTP_PASSWORD:-}" ]; then
    echo "  WARNING: SMTP_PASSWORD not set — storing placeholder. GitLab email will not work until you set"
    echo "           SMTP_PASSWORD in .env and re-run: echo -n '<password>' | gcloud secrets versions add gitlab-smtp-password --data-file=- --project $GCP_PROJECT_ID"
    SMTP_PASSWORD="disabled"
  fi
  echo -n "$SMTP_PASSWORD" | gcloud secrets versions add "gitlab-smtp-password" --data-file=- --project "$GCP_PROJECT_ID"
  echo "  gitlab-smtp-password stored in Secret Manager."
fi

# ── Topology service DB password ─────────────────────────────────────
TOPOLOGY_DB_SECRET="gitlab-topology-db-db-password"
if ! kubectl get secret "$TOPOLOGY_DB_SECRET" -n default &>/dev/null; then
  TOPOLOGY_DB_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)
  kubectl create secret generic "$TOPOLOGY_DB_SECRET" \
    --from-literal=password="$TOPOLOGY_DB_PASS" -n default
  echo "  Created K8s secret $TOPOLOGY_DB_SECRET"
else
  TOPOLOGY_DB_PASS=$(kubectl get secret "$TOPOLOGY_DB_SECRET" -o jsonpath='{.data.password}' | base64 -d)
fi
if secret_has_version "gitlab-topology-db-password"; then
  echo "  gitlab-topology-db-password already set — skipping"
else
  echo -n "$TOPOLOGY_DB_PASS" | gcloud secrets versions add "gitlab-topology-db-password" \
    --data-file=- --project "$GCP_PROJECT_ID"
fi

# ── Grafana admin password ────────────────────────────────────────────
# Generated once. To rotate: gcloud secrets versions add gitlab-grafana-admin-password ...
# then restart grafana pod: kubectl -n system rollout restart deploy/grafana
if secret_has_version "gitlab-grafana-admin-password"; then
  echo "  gitlab-grafana-admin-password already set — skipping"
  echo "  Retrieve: gcloud secrets versions access latest --secret=gitlab-grafana-admin-password --project \$GCP_PROJECT_ID"
else
  GRAFANA_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
  echo -n "$GRAFANA_PASS" | gcloud secrets versions add "gitlab-grafana-admin-password" \
    --data-file=- --project "$GCP_PROJECT_ID"
  echo "  Grafana admin password stored."
  echo "  Retrieve: gcloud secrets versions access latest --secret=gitlab-grafana-admin-password --project \$GCP_PROJECT_ID"
fi

# ── Topology service DB host ──────────────────────────────────────────
TOPOLOGY_PG_IP=$(kubectl get sqlinstances "gitlab-topology-db" \
  -o jsonpath='{.status.privateIpAddress}' 2>/dev/null || echo "")
if [ -n "$TOPOLOGY_PG_IP" ]; then
  if grep -q '^TOPOLOGY_DB_HOST=' .env; then
    sed -i.bak "s/^TOPOLOGY_DB_HOST=.*/TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}/" .env
  else
    echo "TOPOLOGY_DB_HOST=${TOPOLOGY_PG_IP}" >> .env
  fi
  echo "Topology DB host: ${TOPOLOGY_PG_IP}"
fi

# ── Read ingress IP (may not be available until after system deploy) ──
INGRESS_IP=$(kubectl -n system get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PENDING")
if grep -q '^INGRESS_IP=' .env; then
  sed -i.bak "s/^INGRESS_IP=.*/INGRESS_IP=${INGRESS_IP}/" .env
else
  echo "INGRESS_IP=${INGRESS_IP}" >> .env
fi
echo "Ingress IP: ${INGRESS_IP}"
