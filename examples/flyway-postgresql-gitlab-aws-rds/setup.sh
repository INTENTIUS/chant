#!/usr/bin/env bash
# Creates the SSM parameter required by the flyway-rds example stack.
# Run once before deploying: ./setup.sh
set -euo pipefail

SSM_PATH="${1:-/myapp/dev/db-password}"
# Use hex encoding to avoid characters RDS rejects (/, @, ", space)
PASSWORD="$(openssl rand -hex 16)"

echo "Creating SSM SecureString at ${SSM_PATH}…"
aws ssm put-parameter \
  --name "$SSM_PATH" \
  --type SecureString \
  --value "$PASSWORD" \
  --overwrite \
  --region "${AWS_DEFAULT_REGION:-us-east-1}"

echo "Done. Password stored in SSM (not echoed)."
