#!/usr/bin/env bash
# Creates the SSM parameter required by the rds-postgres example stack.
# Run once before deploying: ./setup.sh
set -euo pipefail

SSM_PATH="${1:-/myapp/dev/db-password}"
PASSWORD="$(openssl rand -base64 24)"

echo "Creating SSM SecureString at ${SSM_PATH}…"
aws ssm put-parameter \
  --name "$SSM_PATH" \
  --type SecureString \
  --value "$PASSWORD" \
  --overwrite

echo "Done. Password stored in SSM (not echoed)."
