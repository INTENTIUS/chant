#!/usr/bin/env bash
#
# Bring up the throwaway Forgejo stack, mint an admin access token, and export
# FORGEJO_E2E_URL / FORGEJO_E2E_TOKEN for the e2e suite.
#
# In GitHub Actions ($GITHUB_ENV set) the values are appended there so later
# steps inherit them; locally it prints `export …` lines, so use:
#
#     eval "$(e2e/bootstrap.sh)"     # then: npm run test:e2e:run
#
# Idempotent enough for re-runs: a second admin-create is tolerated.
set -euo pipefail

COMPOSE="docker compose -f e2e/docker-compose.yml"
URL="http://localhost:3000"
ADMIN_USER="warden-admin"
ADMIN_PW="Warden-e2e-pw-1234"
ADMIN_EMAIL="warden-admin@example.com"

log() { echo "[bootstrap] $*" >&2; }

log "starting Forgejo…"
$COMPOSE up -d >&2

log "waiting for the API to answer…"
for i in $(seq 1 60); do
  if curl -fsS "${URL}/api/v1/version" >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" = "60" ]; then log "Forgejo did not become ready in time"; $COMPOSE logs >&2 || true; exit 1; fi
done

log "creating admin user (tolerating 'already exists')…"
$COMPOSE exec -T -u git forgejo forgejo admin user create \
  --admin --username "$ADMIN_USER" --password "$ADMIN_PW" \
  --email "$ADMIN_EMAIL" --must-change-password=false >&2 2>&1 || true

log "minting an access token…"
TOKEN="$($COMPOSE exec -T -u git forgejo forgejo admin user generate-access-token \
  --username "$ADMIN_USER" --scopes all --raw | tr -d '\r\n')"

if [ -z "$TOKEN" ]; then log "failed to mint a token"; exit 1; fi
log "token minted (${#TOKEN} chars)"

if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "FORGEJO_E2E_URL=${URL}"
    echo "FORGEJO_E2E_TOKEN=${TOKEN}"
  } >> "$GITHUB_ENV"
  log "exported to \$GITHUB_ENV"
else
  echo "export FORGEJO_E2E_URL=${URL}"
  echo "export FORGEJO_E2E_TOKEN=${TOKEN}"
fi
