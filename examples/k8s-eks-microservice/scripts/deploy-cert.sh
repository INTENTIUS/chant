#!/usr/bin/env bash
set -euo pipefail

stack=$(aws cloudformation describe-stacks --stack-name eks-microservice --output json)
get_param() { echo "$stack" | jq -r ".Stacks[0].Parameters[] | select(.ParameterKey==\"$1\") | .ParameterValue"; }
get_output() { echo "$stack" | jq -r ".Stacks[0].Outputs[] | select(.OutputKey==\"$1\") | .OutputValue"; }

domain=$(get_param domainName)
hosted_zone_id=$(get_output hostedZoneIdOutput)

echo "Requesting ACM certificate for ${domain}..."
cert_arn=$(aws acm request-certificate \
    --domain-name "$domain" \
    --validation-method DNS \
    --domain-validation-options "DomainName=$domain,ValidationDomain=$domain" \
    --query CertificateArn --output text)
echo "$cert_arn" > .cert-arn
echo "Certificate ARN: $cert_arn"

echo "Waiting for DNS validation records..."
sleep 5
validation=$(aws acm describe-certificate --certificate-arn "$cert_arn" \
    --query 'Certificate.DomainValidationOptions[0]' --output json)
cname_name=$(echo "$validation" | jq -r '.ResourceRecord.Name')
cname_value=$(echo "$validation" | jq -r '.ResourceRecord.Value')

echo "Creating Route53 CNAME: $cname_name -> $cname_value"
aws route53 change-resource-record-sets --hosted-zone-id "$hosted_zone_id" --change-batch "{
  \"Changes\": [{
    \"Action\": \"UPSERT\",
    \"ResourceRecordSet\": {
      \"Name\": \"$cname_name\",
      \"Type\": \"CNAME\",
      \"TTL\": 300,
      \"ResourceRecords\": [{\"Value\": \"$cname_value\"}]
    }
  }]
}"

echo "Waiting for certificate validation (this may take a few minutes)..."
aws acm wait certificate-validated --certificate-arn "$cert_arn"
echo "Certificate validated! ARN saved to .cert-arn"
echo "Run 'bun run load-outputs' to update .env, then 'bun run build:k8s && bun run apply'"
