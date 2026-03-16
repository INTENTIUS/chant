#!/usr/bin/env bash
# k3d-validate.sh — routing validation for the local k3d smoke test.
# Called by k3d-smoke.sh after pods are Ready.
# Can also be run standalone against an already-running smoke cluster:
#   bash scripts/k3d-validate.sh
set -euo pipefail

# Direct cell-router NodePort (routing logic tests)
BASE_URL="http://localhost:8080"
# Nginx ingress NodePort (wildcard Host-header routing tests)
NGINX_URL="http://localhost:8081"
# Default smoke-test domain (matches config.ts default + Ingress host rules)
SMOKE_DOMAIN="${DOMAIN:-gitlab.example.com}"

# Derive cell names from config.ts — no hardcoded alpha/beta.
# CELL_1/CELL_2 are keyed by cellId (routing token prefix integer).
CELL_1=$(bun -e "import { cells } from './src/config.ts'; process.stdout.write(cells.find(c => c.cellId === 1)?.name ?? '')")
CELL_2=$(bun -e "import { cells } from './src/config.ts'; process.stdout.write(cells.find(c => c.cellId === 2)?.name ?? '')")
CANARY_CELL=$(bun -e "import { cells } from './src/config.ts'; process.stdout.write(cells.find(c => c.canary)?.name ?? '')")

PASS=0
FAIL=0

ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# curl helper: always exits 0 so `set -e` does not abort on connection errors.
# Failed connections produce an empty $BODY; grep tests then naturally fail
# and the fail() function records the failure rather than the script aborting.
http_get() {
  local url="$1"; shift
  curl -s --max-time 10 "$@" "$url" || true
}

echo "=== Routing Validation ==="

# Wait for the cell-router NodePort to be reachable before running tests.
# `rollout status` in the smoke script confirms the pod is Ready, but the
# k3d NodePort forwarding can take a few extra seconds to become accessible.
echo "Waiting for cell-router NodePort to be reachable..."
for i in $(seq 1 20); do
  if curl -sf --max-time 3 "${BASE_URL}/healthz" > /dev/null 2>&1; then
    echo "  cell-router is up."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "  FAIL: cell-router not reachable at ${BASE_URL}/healthz after 40s"
    exit 1
  fi
  echo "  attempt $i/20 — retrying in 2s..."
  sleep 2
done

# ── Test 1: Health endpoint ──────────────────────────────────────────────────
echo "Test 1: /healthz → 200 ok"
RESP=$(http_get "${BASE_URL}/healthz" -o /dev/null -w "%{http_code}")
if [ "$RESP" = "200" ]; then
  ok "/healthz returned HTTP 200"
else
  fail "/healthz returned HTTP ${RESP} (expected 200)"
fi

# ── Test 2: Session cookie → cell 1 ─────────────────────────────────────────
# _gitlab_session=cell1_<anything> — cell prefix "cell1_" maps to cellId=1
# (see session_token rule in routing-rules.json)
echo "Test 2: Session cookie cell1_* → ${CELL_1}"
BODY=$(http_get "${BASE_URL}/" -H "Cookie: _gitlab_session=cell1_abc123def456")
if echo "$BODY" | grep -q "cell=${CELL_1}"; then
  ok "Session cookie 'cell1_' routed to ${CELL_1}"
else
  fail "Session cookie 'cell1_' did NOT route to ${CELL_1} (got: ${BODY})"
fi

# ── Test 3: Routable token → cell 2 ──────────────────────────────────────────
# Authorization: Bearer glrt-t2_<token> — GitLab 17.7+ format: glrt-t{cellId}_
# Pattern "^glrt-t(\d+)_" extracts cellId; cellIdMap resolves "2" → CELL_2 name.
# (see routable_token rule in routing-rules.json)
echo "Test 3: Routable token glrt-t2_* → ${CELL_2}"
BODY=$(http_get "${BASE_URL}/" -H "Authorization: Bearer glrt-t2_xyzXYZ789")
if echo "$BODY" | grep -q "cell=${CELL_2}"; then
  ok "Routable token 'glrt-t2_' routed to ${CELL_2}"
else
  fail "Routable token 'glrt-t2_' did NOT route to ${CELL_2} (got: ${BODY})"
fi

# ── Test 4: Path fallback via topology service → canary cell ─────────────────
# No session cookie or routable token → cell-router calls topology-service
# /api/v1/cell_for_org?org_slug=some-org → {"cell":"<canary>","cell_id":1} (default)
echo "Test 4: Path fallback /some-org/ → topology service → ${CANARY_CELL}"
BODY=$(http_get "${BASE_URL}/some-org/project")
if echo "$BODY" | grep -q "cell=${CANARY_CELL}"; then
  ok "Path fallback /some-org/ routed to ${CANARY_CELL} via topology service"
else
  fail "Path fallback /some-org/ did NOT route to ${CANARY_CELL} (got: ${BODY})"
fi

# ── Test 5: Session prefix cell2_ → cell 2 ───────────────────────────────────
# _gitlab_session=cell2_<anything> — cell prefix "cell2_" maps to cellId=2
echo "Test 5: Session cookie cell2_* → ${CELL_2}"
BODY=$(http_get "${BASE_URL}/" -H "Cookie: _gitlab_session=cell2_zyxwvu654321")
if echo "$BODY" | grep -q "cell=${CELL_2}"; then
  ok "Session cookie 'cell2_' routed to ${CELL_2}"
else
  fail "Session cookie 'cell2_' did NOT route to ${CELL_2} (got: ${BODY})"
fi

# ── Test 6: Routable token → cell 1 ──────────────────────────────────────────
# Authorization: Bearer glrt-t1_<token> — GitLab 17.7+ format: glrt-t{cellId}_
echo "Test 6: Routable token glrt-t1_* → ${CELL_1}"
BODY=$(http_get "${BASE_URL}/" -H "Authorization: Bearer glrt-t1_aaa111bbb")
if echo "$BODY" | grep -q "cell=${CELL_1}"; then
  ok "Routable token 'glrt-t1_' routed to ${CELL_1}"
else
  fail "Routable token 'glrt-t1_' did NOT route to ${CELL_1} (got: ${BODY})"
fi

# ── Nginx ingress tests (Host-header wildcard routing) ───────────────────────
# These tests validate that the Ingress host rules correctly handle two-level
# subdomain hosts like gitlab.alpha.gitlab.example.com.
#
# Background: nginx wildcard *.domain only matches ONE subdomain level.
# Without per-cell wildcard rules (*.alpha.domain), cell URLs at depth-2
# get 404. This section catches that class of misconfiguration locally.
echo ""
echo "=== Nginx Ingress Wildcard Routing ==="

# Wait for ingress-nginx to be reachable on port 8081.
echo "Waiting for ingress-nginx to be reachable..."
for i in $(seq 1 20); do
  # Use cell-1 host to probe — any response (even 404) means nginx is up
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
    -H "Host: gitlab.${CELL_1}.${SMOKE_DOMAIN}" "${NGINX_URL}/" || echo "000")
  if [ "$STATUS" != "000" ]; then
    echo "  ingress-nginx is up (HTTP ${STATUS})."
    break
  fi
  if [ "$i" -eq 20 ]; then
    echo "  FAIL: ingress-nginx not reachable at ${NGINX_URL} after 40s"
    FAIL=$((FAIL + 1))
    break
  fi
  echo "  attempt $i/20 — retrying in 2s..."
  sleep 2
done

# Test 7: Two-level cell host via nginx → cell 1
# Host: gitlab.<cell1>.gitlab.example.com matches *.<cell1>.gitlab.example.com
# Without per-cell wildcard in Ingress, nginx returns 404 here.
echo "Test 7: nginx Host: gitlab.${CELL_1}.DOMAIN → ${CELL_1} (two-level wildcard)"
BODY=$(http_get "${NGINX_URL}/" \
  -H "Cookie: _gitlab_session=cell1_smoke001" \
  -H "Host: gitlab.${CELL_1}.${SMOKE_DOMAIN}")
if echo "$BODY" | grep -q "cell=${CELL_1}"; then
  ok "nginx two-level wildcard *.${CELL_1}.DOMAIN routed to ${CELL_1}"
else
  fail "nginx two-level wildcard *.${CELL_1}.DOMAIN did NOT route to ${CELL_1} (got: ${BODY:-<empty>}) — check Ingress host rules"
fi

# Test 8: Two-level cell host via nginx → cell 2
echo "Test 8: nginx Host: gitlab.${CELL_2}.DOMAIN → ${CELL_2} (two-level wildcard)"
BODY=$(http_get "${NGINX_URL}/" \
  -H "Cookie: _gitlab_session=cell2_smoke002" \
  -H "Host: gitlab.${CELL_2}.${SMOKE_DOMAIN}")
if echo "$BODY" | grep -q "cell=${CELL_2}"; then
  ok "nginx two-level wildcard *.${CELL_2}.DOMAIN routed to ${CELL_2}"
else
  fail "nginx two-level wildcard *.${CELL_2}.DOMAIN did NOT route to ${CELL_2} (got: ${BODY:-<empty>}) — check Ingress host rules"
fi

# Test 9: One-level wildcard still works (top-level alias)
# Host: <cell1>.gitlab.example.com matches *.gitlab.example.com
echo "Test 9: nginx Host: ${CELL_1}.DOMAIN → ${CELL_1} (one-level wildcard)"
BODY=$(http_get "${NGINX_URL}/" \
  -H "Cookie: _gitlab_session=cell1_smoke003" \
  -H "Host: ${CELL_1}.${SMOKE_DOMAIN}")
if echo "$BODY" | grep -q "cell=${CELL_1}"; then
  ok "nginx one-level wildcard *.DOMAIN routed to ${CELL_1}"
else
  fail "nginx one-level wildcard *.DOMAIN did NOT route to ${CELL_1} (got: ${BODY:-<empty>})"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
fi
