#!/usr/bin/env bash
# Tear down the EDA HPC Slurm cluster and all associated AWS resources.
#
# Usage:
#   npm run teardown
#   # or directly:
#   ./scripts/teardown.sh [cluster-name] [region]
#
# CAUTION: This deletes all cluster resources including FSx (scratch data
# will be lost unless you've created a data repository association).
# Scale GPU ASG to 0 before running to avoid termination of active jobs.

set -euo pipefail

CLUSTER_NAME="${1:-${CLUSTER_NAME:-eda-hpc}}"
REGION="${2:-${AWS_REGION:-us-east-1}}"

echo "==> Teardown: ${CLUSTER_NAME} in ${REGION}"
echo ""
echo "WARNING: This will permanently delete:"
echo "  - CloudFormation stack ${CLUSTER_NAME}-infra (VPC, FSx, Aurora, EC2, ASG)"
echo "  - SSM parameters under /${CLUSTER_NAME}/"
echo "  - Slurm accounting data in Aurora MySQL"
echo ""
read -r -p "Type the cluster name to confirm deletion: " CONFIRM
if [ "${CONFIRM}" != "${CLUSTER_NAME}" ]; then
  echo "Aborted."
  exit 1
fi

# ── Scale GPU ASG to 0 first ───────────────────────────────────────
# Prevents Slurm from trying to submit jobs to terminating nodes.

echo ""
echo "==> Scaling GPU ASG to 0"
ASG_NAME="${CLUSTER_NAME}-gpu-asg"
if aws autoscaling describe-auto-scaling-groups \
     --auto-scaling-group-names "${ASG_NAME}" \
     --region "${REGION}" \
     --query "AutoScalingGroups[0].AutoScalingGroupName" \
     --output text 2>/dev/null | grep -q "${ASG_NAME}"; then
  aws autoscaling update-auto-scaling-group \
    --auto-scaling-group-name "${ASG_NAME}" \
    --min-size 0 --max-size 0 --desired-capacity 0 \
    --region "${REGION}"
  echo "    Scaled to 0 — waiting 60s for instances to terminate"
  sleep 60
else
  echo "    ASG ${ASG_NAME} not found — skipping"
fi

# ── Delete CloudFormation stack ────────────────────────────────────

echo ""
echo "==> Deleting CloudFormation stack: ${CLUSTER_NAME}-infra"
echo "    (FSx deletion takes 5-10 min)"

aws cloudformation delete-stack \
  --stack-name "${CLUSTER_NAME}-infra" \
  --region "${REGION}"

# Wait for deletion
while true; do
  STATUS=$(aws cloudformation describe-stacks \
    --stack-name "${CLUSTER_NAME}-infra" \
    --region "${REGION}" \
    --query "Stacks[0].StackStatus" \
    --output text 2>/dev/null || echo "DELETED")

  echo "  [${STATUS}]"

  case "${STATUS}" in
    DELETED|DELETE_COMPLETE)
      echo "    Stack deleted."
      break
      ;;
    DELETE_FAILED)
      echo "ERROR: Stack deletion failed. Check CloudFormation events:"
      echo "       aws cloudformation describe-stack-events --stack-name ${CLUSTER_NAME}-infra --region ${REGION}"
      exit 1
      ;;
  esac
  sleep 30
done

# ── Clean up SSM parameters ────────────────────────────────────────

echo ""
echo "==> Deleting SSM parameters under /${CLUSTER_NAME}/"

PARAMS=$(aws ssm get-parameters-by-path \
  --path "/${CLUSTER_NAME}/" \
  --region "${REGION}" \
  --query "Parameters[].Name" \
  --output text 2>/dev/null || echo "")

if [ -n "${PARAMS}" ]; then
  # shellcheck disable=SC2086
  aws ssm delete-parameters \
    --names ${PARAMS} \
    --region "${REGION}" > /dev/null
  echo "    Deleted: ${PARAMS}"
else
  echo "    No parameters found."
fi

# ── Delete SSM Automation document ────────────────────────────────

echo ""
echo "==> Deleting SSM Automation document"
aws ssm delete-document \
  --name "${CLUSTER_NAME}-post-provision" \
  --region "${REGION}" 2>/dev/null || echo "    Document not found — skipping"

echo ""
echo "==> Teardown complete."
