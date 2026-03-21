#!/usr/bin/env bash
# Deploy the EDA HPC Slurm cluster via SSM Automation.
#
# Usage:
#   ./scripts/deploy.sh [cluster-name] [region]
#
# Prerequisites:
#   - AWS CLI configured with credentials
#   - SSM Automation execution role (arn:aws:iam::...:role/SSMAutomationRole)
#   - chant build already run (dist/ populated)

set -euo pipefail

CLUSTER_NAME="${1:-eda-hpc}"
REGION="${2:-us-east-1}"
DOCUMENT_NAME="EdaHpcBootstrap"

echo "==> Deploying ${CLUSTER_NAME} in ${REGION}"

# Start automation execution
EXECUTION_ID=$(aws ssm start-automation-execution \
  --document-name "${DOCUMENT_NAME}" \
  --region "${REGION}" \
  --parameters \
    "ClusterName=${CLUSTER_NAME},Region=${REGION}" \
  --query "AutomationExecutionId" \
  --output text)

echo "==> Execution ID: ${EXECUTION_ID}"
echo "==> Tracking: https://console.aws.amazon.com/systems-manager/automation/executions/${EXECUTION_ID}"

# Poll until complete
while true; do
  STATUS=$(aws ssm get-automation-execution \
    --automation-execution-id "${EXECUTION_ID}" \
    --region "${REGION}" \
    --query "AutomationExecution.AutomationExecutionStatus" \
    --output text)

  STEP=$(aws ssm get-automation-execution \
    --automation-execution-id "${EXECUTION_ID}" \
    --region "${REGION}" \
    --query "AutomationExecution.CurrentStepName" \
    --output text 2>/dev/null || echo "unknown")

  echo "  [${STATUS}] Step: ${STEP}"

  case "${STATUS}" in
    Success)
      echo ""
      echo "==> Cluster deployed successfully!"
      echo "==> Connect: ssh -i ~/.ssh/hpc.pem ec2-user@\$(aws ssm get-parameter --name /${CLUSTER_NAME}/head-node-ip --query Parameter.Value --output text)"
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      echo ""
      echo "==> Deployment failed with status: ${STATUS}"
      echo "==> Check logs at: https://console.aws.amazon.com/systems-manager/automation/executions/${EXECUTION_ID}"
      exit 1
      ;;
  esac

  sleep 30
done
