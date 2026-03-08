#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-cells-cluster}"
REGION="${AWS_REGION:-us-east-1}"
ENV_FILE=".env"

echo "Loading outputs from stack $STACK_NAME..."

outputs=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)

get_output() {
  echo "$outputs" | jq -r ".[] | select(.OutputKey==\"$1\") | .OutputValue // empty"
}

cat > "$ENV_FILE" <<EOF
AWS_REGION=$REGION
CLUSTER_AUTOSCALER_ROLE_ARN=$(get_output ClusterAutoscalerRoleArn)
OIDC_PROVIDER_ARN=$(get_output OidcProviderArn)
ECR_REPO_URI=$(get_output RepoUri)
CELL_ALPHA_ROLE_ARN=$(get_output CellAlphaRoleArn)
CELL_BETA_ROLE_ARN=$(get_output CellBetaRoleArn)
EOF

echo "Wrote $ENV_FILE"
cat "$ENV_FILE"
