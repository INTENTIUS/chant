#!/usr/bin/env bash
# Pre-deployment prerequisites check for slurm-aws-hpc.
# Run this before `npm run deploy`.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-eda-hpc}"
REQUIRED_P4D_VCPUS=96   # one p4d.24xlarge

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0

ok()   { echo -e "${GREEN}[OK]${NC}    $*"; ((PASS++)); }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; ((WARN++)); }
fail() { echo -e "${RED}[FAIL]${NC}  $*"; ((FAIL++)); }

echo "=== slurm-aws-hpc bootstrap check ==="
echo

# ── AWS CLI ──────────────────────────────────────────────────────────────────
if ! command -v aws &>/dev/null; then
  fail "aws CLI not found. Install from https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
else
  AWS_VER=$(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)
  MAJOR=${AWS_VER%%.*}
  if [[ "$MAJOR" -ge 2 ]]; then
    ok "aws CLI $AWS_VER"
  else
    fail "aws CLI $AWS_VER is too old — version 2.x required"
  fi
fi

# ── Node / bun ───────────────────────────────────────────────────────────────
if command -v bun &>/dev/null; then
  ok "bun $(bun --version)"
elif command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  fail "npm or bun required"
fi

# ── jq ───────────────────────────────────────────────────────────────────────
if command -v jq &>/dev/null; then
  ok "jq $(jq --version)"
else
  fail "jq not found — required for deploy.sh parsing"
fi

# ── AWS credentials ───────────────────────────────────────────────────────────
if IDENTITY=$(aws sts get-caller-identity --output json 2>&1); then
  ACCOUNT=$(echo "$IDENTITY" | jq -r '.Account')
  ARN=$(echo "$IDENTITY"     | jq -r '.Arn')
  ok "Authenticated as $ARN (account $ACCOUNT)"
else
  fail "AWS credential check failed: $IDENTITY"
fi

# ── p4d.24xlarge vCPU quota ───────────────────────────────────────────────────
# Service quota L-417A185B = Running On-Demand P instances (vCPUs)
QUOTA=$(aws service-quotas get-service-quota \
  --service-code ec2 \
  --quota-code L-417A185B \
  --query 'Quota.Value' \
  --output text 2>/dev/null || echo "0")
QUOTA_INT=${QUOTA%%.*}
if [[ "$QUOTA_INT" -ge "$REQUIRED_P4D_VCPUS" ]]; then
  ok "p4d vCPU quota: $QUOTA_INT (need $REQUIRED_P4D_VCPUS)"
elif [[ "$QUOTA_INT" -eq 0 ]]; then
  fail "p4d vCPU quota: 0 — you have no P-instance quota. Request at least $REQUIRED_P4D_VCPUS vCPUs at https://console.aws.amazon.com/servicequotas (quota L-417A185B)."
else
  warn "p4d vCPU quota: $QUOTA_INT — need at least $REQUIRED_P4D_VCPUS for one p4d.24xlarge. Request an increase at Service Quotas console."
fi

# ── .env file ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
ENV_EXAMPLE="$SCRIPT_DIR/../.env.example"

if [[ -f "$ENV_FILE" ]]; then
  ok ".env present"
else
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    warn ".env not found — copied from .env.example. Edit $ENV_FILE and re-run this script."
  else
    warn ".env not found — create one with AWS_REGION and CLUSTER_NAME"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "Results: ${GREEN}${PASS} ok${NC}, ${YELLOW}${WARN} warnings${NC}, ${RED}${FAIL} failures${NC}"
echo

if [[ "$FAIL" -gt 0 ]]; then
  echo -e "${RED}Fix failures above before deploying.${NC}"
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  echo -e "${YELLOW}Warnings above are non-blocking but should be reviewed.${NC}"
  echo "Ready to deploy: npm run deploy"
else
  echo -e "${GREEN}All checks passed. Ready to deploy: npm run deploy${NC}"
fi
