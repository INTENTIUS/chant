#!/usr/bin/env bash
set -euo pipefail

stack=$(aws cloudformation describe-stacks --stack-name eks-microservice --output json)
get_output() { echo "$stack" | jq -r ".Stacks[0].Outputs[] | select(.OutputKey==\"$1\") | .OutputValue"; }
get_param() { echo "$stack" | jq -r ".Stacks[0].Parameters[] | select(.ParameterKey==\"$1\") | .ParameterValue"; }

cert_arn=""
if [ -f .cert-arn ]; then cert_arn=$(cat .cert-arn); fi

cat > .env <<EOF
APP_ROLE_ARN=$(get_output appRoleArn)
EXTERNAL_DNS_ROLE_ARN=$(get_output externalDnsRoleArn)
FLUENT_BIT_ROLE_ARN=$(get_output fluentBitRoleArn)
ADOT_ROLE_ARN=$(get_output adotRoleArn)
ALB_CERT_ARN=${cert_arn}
HOSTED_ZONE_ID=$(get_output hostedZoneIdOutput)
DOMAIN=$(get_param domainName)
EKS_CLUSTER_NAME=eks-microservice
AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
EOF

echo "Wrote .env with stack output ARNs and parameters"

hosted_zone_id=$(get_output hostedZoneIdOutput)
echo ""
if [ -n "$hosted_zone_id" ]; then
  ns=$(aws route53 get-hosted-zone --id "$hosted_zone_id" --query 'DelegationSet.NameServers' --output text 2>/dev/null | tr '\t' ', ')
  echo "Route53 nameservers: $ns"
  echo "Update your domain registrar NS records to the nameservers above."
fi
if [ -z "$cert_arn" ]; then
  echo ""
  echo "No ACM certificate yet. After NS delegation, run: npm run deploy-cert"
fi
