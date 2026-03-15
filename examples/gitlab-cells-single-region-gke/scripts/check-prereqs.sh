#!/usr/bin/env bash
# check-prereqs.sh — validates required CLI tools and versions before deploying.
# Run: bash scripts/check-prereqs.sh
# Referenced from bootstrap.sh and README.
set -euo pipefail

ERRORS=0

fail() { echo "  FAIL: $1"; ERRORS=$((ERRORS + 1)); }
pass() { echo "  OK:   $1"; }

# Compare two version strings (major.minor.patch). Returns 0 if $1 >= $2.
version_gte() {
  [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

echo "=== Checking prerequisites ==="

# node >= 18 (required for npm run build / chant CLI)
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null | sed 's/^v//')
  if version_gte "$NODE_VER" "18.0.0"; then
    pass "node ${NODE_VER}"
  else
    fail "node ${NODE_VER} — need >= 18 (install via nvm or https://nodejs.org)"
  fi
else
  fail "node not found — required for npm run build / chant CLI (install via nvm or https://nodejs.org)"
fi

# npm (comes with node)
if command -v npm &>/dev/null; then
  pass "npm $(npm --version 2>/dev/null)"
else
  fail "npm not found — install Node.js to get npm"
fi

# gcloud >= 450
if command -v gcloud &>/dev/null; then
  GCLOUD_VER=$(gcloud version 2>/dev/null | grep 'Google Cloud SDK' | awk '{print $NF}')
  if version_gte "$GCLOUD_VER" "450.0.0"; then
    pass "gcloud ${GCLOUD_VER}"
  else
    fail "gcloud ${GCLOUD_VER} — need >= 450.0.0 (run: gcloud components update)"
  fi
else
  fail "gcloud not found — install from https://cloud.google.com/sdk/docs/install"
fi

# kubectl >= 1.28
if command -v kubectl &>/dev/null; then
  KUBECTL_VER=$(kubectl version --client -o json 2>/dev/null | python3 -c \
    "import sys,json; v=json.load(sys.stdin)['clientVersion']; print(f\"{v['major']}.{v['minor']}.0\")" 2>/dev/null || echo "0.0.0")
  if version_gte "$KUBECTL_VER" "1.28.0"; then
    pass "kubectl ${KUBECTL_VER}"
  else
    fail "kubectl ${KUBECTL_VER} — need >= 1.28"
  fi
else
  fail "kubectl not found — install from https://kubernetes.io/docs/tasks/tools/"
fi

# helm >= 3.14
if command -v helm &>/dev/null; then
  HELM_VER=$(helm version --short 2>/dev/null | sed 's/^v//' | cut -d'+' -f1)
  if version_gte "$HELM_VER" "3.14.0"; then
    pass "helm ${HELM_VER}"
  else
    fail "helm ${HELM_VER} — need >= 3.14 (run: helm version)"
  fi
else
  fail "helm not found — install from https://helm.sh/docs/intro/install/"
fi

# jq (any version)
if command -v jq &>/dev/null; then
  pass "jq $(jq --version 2>/dev/null)"
else
  fail "jq not found — install via package manager (brew install jq / apt install jq)"
fi

# docker
if command -v docker &>/dev/null; then
  DOCKER_VER=$(docker version --format '{{.Client.Version}}' 2>/dev/null || echo "unknown")
  pass "docker ${DOCKER_VER}"
else
  fail "docker not found — required for building cell-router and topology-service images"
fi

# openssl
if command -v openssl &>/dev/null; then
  pass "openssl $(openssl version 2>/dev/null | cut -d' ' -f2)"
else
  fail "openssl not found — install via package manager"
fi

# python3
if command -v python3 &>/dev/null; then
  PYTHON_VER=$(python3 --version 2>/dev/null | cut -d' ' -f2)
  pass "python3 ${PYTHON_VER}"
else
  fail "python3 not found — required for scripts/create-root-pat.py"
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "All prerequisites satisfied. You're ready to deploy."
  exit 0
else
  echo "${ERRORS} prerequisite(s) missing — fix the above before deploying."
  exit 1
fi
