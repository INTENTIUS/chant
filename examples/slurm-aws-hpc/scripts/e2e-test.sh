#!/usr/bin/env bash
# Post-deploy end-to-end validation for slurm-aws-hpc.
# Run after `npm run deploy` completes successfully.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-eda-hpc}"
STACK_NAME="${STACK_NAME:-$CLUSTER_NAME}"
REGION="${AWS_REGION:-us-east-1}"
TEST_PARTITION="${TEST_PARTITION:-synthesis}"
TEST_TIMEOUT=120   # seconds to wait for test job

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

ok()   { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS++)); }
fail() { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL++)); }
info() { echo -e "${YELLOW}[INFO]${NC} $*"; }

echo "=== slurm-aws-hpc e2e validation ==="
echo "Stack: $STACK_NAME | Region: $REGION"
echo

# ── CloudFormation stack ──────────────────────────────────────────────────────
info "Checking CloudFormation stack..."
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "MISSING")
if [[ "$STACK_STATUS" == "CREATE_COMPLETE" || "$STACK_STATUS" == "UPDATE_COMPLETE" ]]; then
  ok "Stack status: $STACK_STATUS"
else
  fail "Stack status: $STACK_STATUS (expected CREATE_COMPLETE)"
fi

# ── Head node EC2 instance ────────────────────────────────────────────────────
info "Checking head node..."
HEAD_INSTANCE=$(aws ec2 describe-instances \
  --filters \
    "Name=tag:cluster,Values=$CLUSTER_NAME" \
    "Name=tag:role,Values=head" \
    "Name=instance-state-name,Values=running" \
  --region "$REGION" \
  --query 'Reservations[0].Instances[0].InstanceId' \
  --output text 2>/dev/null || echo "None")
if [[ "$HEAD_INSTANCE" != "None" && -n "$HEAD_INSTANCE" ]]; then
  ok "Head node running: $HEAD_INSTANCE"
else
  fail "Head node not found or not running"
  echo "Remaining checks require a running head node — aborting."
  echo
  echo "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
  exit 1
fi

# ── FSx filesystem ───────────────────────────────────────────────────────────
info "Checking FSx Lustre filesystem..."
FSX_STATE=$(aws fsx describe-file-systems \
  --region "$REGION" \
  --query "FileSystems[?Tags[?Key=='cluster'&&Value=='$CLUSTER_NAME']].Lifecycle" \
  --output text 2>/dev/null | head -1)
if [[ "$FSX_STATE" == "AVAILABLE" ]]; then
  ok "FSx filesystem: AVAILABLE"
else
  fail "FSx filesystem: $FSX_STATE (expected AVAILABLE)"
fi

# ── Aurora cluster ────────────────────────────────────────────────────────────
info "Checking Aurora cluster..."
AURORA_STATUS=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$CLUSTER_NAME-slurmdbd" \
  --region "$REGION" \
  --query 'DBClusters[0].Status' \
  --output text 2>/dev/null || echo "missing")
if [[ "$AURORA_STATUS" == "available" ]]; then
  ok "Aurora cluster: available"
else
  fail "Aurora cluster: $AURORA_STATUS (expected available)"
fi

# ── SSM munge key parameter ──────────────────────────────────────────────────
info "Checking SSM munge key parameter..."
MUNGE_PARAM=$(aws ssm get-parameter \
  --name "/$CLUSTER_NAME/munge/key" \
  --region "$REGION" \
  --query 'Parameter.Name' \
  --output text 2>/dev/null || echo "missing")
if [[ "$MUNGE_PARAM" != "missing" ]]; then
  ok "SSM munge key parameter exists"
else
  fail "SSM munge key parameter /$CLUSTER_NAME/munge/key not found"
fi

# ── Slurm service checks via SSM Run Command ──────────────────────────────────
info "Running Slurm service checks on head node via SSM..."

RUN_CMD=$(aws ssm send-command \
  --instance-ids "$HEAD_INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --region "$REGION" \
  --parameters 'commands=[
    "munge --version",
    "echo test | munge | unmunge",
    "scontrol show config | grep ClusterName",
    "sinfo --noheader",
    "squeue --noheader",
    "sacctmgr -n show cluster"
  ]' \
  --query 'Command.CommandId' \
  --output text)

# Poll for completion (up to 60s)
for i in $(seq 1 12); do
  sleep 5
  CMD_STATUS=$(aws ssm get-command-invocation \
    --command-id "$RUN_CMD" \
    --instance-id "$HEAD_INSTANCE" \
    --region "$REGION" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")
  if [[ "$CMD_STATUS" == "Success" || "$CMD_STATUS" == "Failed" ]]; then
    break
  fi
done

CMD_OUTPUT=$(aws ssm get-command-invocation \
  --command-id "$RUN_CMD" \
  --instance-id "$HEAD_INSTANCE" \
  --region "$REGION" \
  --query 'StandardOutputContent' \
  --output text 2>/dev/null || echo "")
CMD_ERR=$(aws ssm get-command-invocation \
  --command-id "$RUN_CMD" \
  --instance-id "$HEAD_INSTANCE" \
  --region "$REGION" \
  --query 'StandardErrorContent' \
  --output text 2>/dev/null || echo "")

if [[ "$CMD_STATUS" == "Success" ]]; then
  ok "munge working"
  if echo "$CMD_OUTPUT" | grep -q "ClusterName"; then
    ok "slurmctld running (ClusterName in config)"
  else
    fail "slurmctld not responding (ClusterName not found in scontrol output)"
  fi
  if echo "$CMD_OUTPUT" | grep -q "$CLUSTER_NAME"; then
    ok "sacctmgr shows cluster $CLUSTER_NAME"
  else
    fail "sacctmgr does not show cluster (accounting not configured)"
  fi
else
  fail "SSM Run Command failed (status: $CMD_STATUS)"
  echo "  stdout: $CMD_OUTPUT"
  echo "  stderr: $CMD_ERR"
fi

# ── Submit test job ───────────────────────────────────────────────────────────
info "Submitting test job to $TEST_PARTITION partition..."

JOB_CMD=$(aws ssm send-command \
  --instance-ids "$HEAD_INSTANCE" \
  --document-name "AWS-RunShellScript" \
  --region "$REGION" \
  --parameters "commands=[
    \"JOB_ID=\$(srun --partition=$TEST_PARTITION --ntasks=1 --time=00:01:00 hostname 2>&1 | tail -1)\",
    \"echo Job output: \$JOB_ID\"
  ]" \
  --timeout-seconds "$TEST_TIMEOUT" \
  --query 'Command.CommandId' \
  --output text 2>/dev/null || echo "failed")

if [[ "$JOB_CMD" != "failed" ]]; then
  # Wait for job to complete
  for i in $(seq 1 $((TEST_TIMEOUT / 5))); do
    sleep 5
    JOB_STATUS=$(aws ssm get-command-invocation \
      --command-id "$JOB_CMD" \
      --instance-id "$HEAD_INSTANCE" \
      --region "$REGION" \
      --query 'Status' \
      --output text 2>/dev/null || echo "Pending")
    if [[ "$JOB_STATUS" == "Success" || "$JOB_STATUS" == "Failed" ]]; then
      break
    fi
  done

  JOB_OUTPUT=$(aws ssm get-command-invocation \
    --command-id "$JOB_CMD" \
    --instance-id "$HEAD_INSTANCE" \
    --region "$REGION" \
    --query 'StandardOutputContent' \
    --output text 2>/dev/null || echo "")

  if [[ "$JOB_STATUS" == "Success" ]]; then
    ok "Test job completed: $JOB_OUTPUT"
  else
    fail "Test job did not complete (status: $JOB_STATUS) — compute nodes may still be provisioning"
    echo "  Tip: check 'sinfo' on the head node and wait for nodes to transition from CLOUD to idle"
  fi
else
  fail "Could not submit test job"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}"
echo
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
else
  echo -e "${GREEN}All checks passed. Cluster is operational.${NC}"
fi
