#!/usr/bin/env bash
# Deploy the EDA HPC Slurm cluster.
#
# Usage:
#   npm run deploy
#   # or directly:
#   ./scripts/deploy.sh [cluster-name] [region]
#
# What this does:
#   1. Pre-flight checks (tools, AWS credentials, env vars)
#   2. npm run build  — generates dist/infra.json + dist/slurm.conf
#   3. Deploy CloudFormation stacks in dependency order
#   4. Run SSM Automation post-provision document (munge key, slurm reconfig, accounts)
#
# Estimated time: ~25 minutes (FSx provisioning is the long pole at 8-15 min)

set -euo pipefail

CLUSTER_NAME="${1:-${CLUSTER_NAME:-eda-hpc}}"
REGION="${2:-${AWS_REGION:-us-east-1}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"

# ── Pre-flight ─────────────────────────────────────────────────────

echo "==> Pre-flight checks"

for tool in aws jq; do
  if ! command -v "${tool}" &>/dev/null; then
    echo "ERROR: ${tool} not found. Install it and retry."
    exit 1
  fi
done

if ! aws sts get-caller-identity --region "${REGION}" &>/dev/null; then
  echo "ERROR: AWS credentials not configured or not valid for region ${REGION}."
  echo "       Run 'aws configure' or set AWS_PROFILE / AWS_ACCESS_KEY_ID."
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "    Account : ${ACCOUNT_ID}"
echo "    Region  : ${REGION}"
echo "    Cluster : ${CLUSTER_NAME}"
echo ""

# ── Ensure S3 bucket for template upload ───────────────────────────
# CFN templates > 51,200 bytes must be uploaded to S3.

CFN_BUCKET="cfn-templates-${ACCOUNT_ID}-${REGION}"

if ! aws s3api head-bucket --bucket "${CFN_BUCKET}" --region "${REGION}" &>/dev/null; then
  echo "==> Creating S3 bucket for CloudFormation templates: ${CFN_BUCKET}"
  if [ "${REGION}" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "${CFN_BUCKET}" --region "${REGION}" > /dev/null
  else
    aws s3api create-bucket --bucket "${CFN_BUCKET}" --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" > /dev/null
  fi
  aws s3api put-bucket-versioning --bucket "${CFN_BUCKET}" \
    --versioning-configuration Status=Enabled > /dev/null
  echo "    Created: s3://${CFN_BUCKET}"
  echo ""
fi

# ── Build ──────────────────────────────────────────────────────────

echo "==> Building CloudFormation template and slurm.conf"
cd "${ROOT_DIR}"
npm run build
echo "    dist/infra.json   $(wc -c < dist/infra.json | tr -d ' ') bytes"
echo "    dist/slurm.conf   $(wc -l < dist/slurm.conf | tr -d ' ') lines"
echo ""

# ── CloudFormation helper ──────────────────────────────────────────

deploy_stack() {
  local stack_name="$1"
  local template_file="$2"
  local extra_args="${3:-}"

  echo "  Deploying stack: ${stack_name}"

  # shellcheck disable=SC2086
  aws cloudformation deploy \
    --stack-name "${stack_name}" \
    --template-file "${template_file}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "${REGION}" \
    --s3-bucket "${CFN_BUCKET}" \
    --s3-prefix "${CLUSTER_NAME}" \
    --tags "cluster=${CLUSTER_NAME}" \
    ${extra_args} || {
      echo "ERROR: Stack ${stack_name} failed. Check CloudFormation events:"
      echo "       aws cloudformation describe-stack-events --stack-name ${stack_name} --region ${REGION}"
      exit 1
    }

  echo "    ${stack_name}: CREATE_COMPLETE"
}

# ── Deploy stacks ──────────────────────────────────────────────────

echo "==> Deploying CloudFormation stacks"
echo "    (full deploy takes ~25 min; FSx provisioning is the long pole)"
echo ""

# chant build produces a single infra.json; in production you'd split into
# nested stacks per logical group. For this example we deploy as one stack.
deploy_stack "${CLUSTER_NAME}-infra" "${ROOT_DIR}/dist/infra.json"

echo ""

# ── Copy slurm.conf to head node ───────────────────────────────────

echo "==> Distributing slurm.conf to head node"

HEAD_INSTANCE=$(aws ec2 describe-instances \
  --filters "Name=tag:cluster,Values=${CLUSTER_NAME}" \
            "Name=tag:role,Values=head" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text \
  --region "${REGION}" 2>/dev/null || echo "None")

if [ "${HEAD_INSTANCE}" = "None" ] || [ -z "${HEAD_INSTANCE}" ]; then
  echo "WARNING: Head node not yet running — skipping slurm.conf upload."
  echo "         Run 'aws ssm send-command ...' manually after the head node starts."
else
  # Stage slurm.conf in SSM Parameter Store to avoid embedding multi-line content
  # with shell-special characters ($, \, ") inside SSM command JSON.
  aws ssm put-parameter \
    --name "/${CLUSTER_NAME}/slurm/conf" \
    --value "$(cat "${ROOT_DIR}/dist/slurm.conf")" \
    --type "String" \
    --overwrite \
    --region "${REGION}" > /dev/null

  CMD_ID=$(aws ssm send-command \
    --instance-ids "${HEAD_INSTANCE}" \
    --document-name "AWS-RunShellScript" \
    --region "${REGION}" \
    --parameters "commands=[
      \"aws ssm get-parameter --name /${CLUSTER_NAME}/slurm/conf --query Parameter.Value --output text --region ${REGION} > /etc/slurm/slurm.conf\",
      \"scontrol reconfigure || true\"
    ]" \
    --output text --query "Command.CommandId")
  echo "    slurm.conf staged to SSM and pushed (command: ${CMD_ID})"
fi

echo ""

# ── SSM Automation post-provision ─────────────────────────────────

DOCUMENT_NAME="${CLUSTER_NAME}-post-provision"

echo "==> Running post-provision automation: ${DOCUMENT_NAME}"

EXECUTION_ID=$(aws ssm start-automation-execution \
  --document-name "${DOCUMENT_NAME}" \
  --region "${REGION}" \
  --parameters "ClusterName=${CLUSTER_NAME}" \
  --query "AutomationExecutionId" \
  --output text)

echo "    Execution ID : ${EXECUTION_ID}"
echo "    Console      : https://${REGION}.console.aws.amazon.com/systems-manager/automation/executions/${EXECUTION_ID}"
echo ""

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
    --output text 2>/dev/null || echo "—")

  echo "  [${STATUS}] ${STEP}"

  case "${STATUS}" in
    Success)
      echo ""
      echo "==> Cluster deployed successfully!"
      echo ""
      echo "Connect to head node:"
      echo "  aws ssm start-session --target ${HEAD_INSTANCE:-<head-instance-id>} --region ${REGION}"
      echo ""
      echo "Run a test job:"
      echo "  srun --partition=synthesis --ntasks=1 hostname"
      echo ""
      echo "Check fairshare:"
      echo "  sshare -l"
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      echo ""
      echo "ERROR: Post-provision automation failed with status: ${STATUS}"
      echo "       Check execution log: https://${REGION}.console.aws.amazon.com/systems-manager/automation/executions/${EXECUTION_ID}"
      exit 1
      ;;
  esac

  sleep 20
done
