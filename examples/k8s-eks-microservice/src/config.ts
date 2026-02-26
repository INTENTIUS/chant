// Cross-lexicon configuration.
// In production, populate these from CloudFormation stack outputs:
//   aws cloudformation describe-stacks --stack-name eks-microservice \
//     --query 'Stacks[0].Outputs'

export const config = {
  clusterName: process.env.EKS_CLUSTER_NAME ?? "eks-microservice",
  region: process.env.AWS_REGION ?? "us-east-1",
  appRoleArn: process.env.APP_ROLE_ARN ?? "arn:aws:iam::123456789012:role/eks-microservice-app-role",
  albCertificateArn: process.env.ALB_CERT_ARN ?? "arn:aws:acm:us-east-1:123456789012:certificate/abc-123-def",
  externalDnsRoleArn: process.env.EXTERNAL_DNS_ROLE_ARN ?? "arn:aws:iam::123456789012:role/eks-microservice-external-dns-role",
  fluentBitRoleArn: process.env.FLUENT_BIT_ROLE_ARN ?? "arn:aws:iam::123456789012:role/eks-microservice-fluent-bit-role",
  adotRoleArn: process.env.ADOT_ROLE_ARN ?? "arn:aws:iam::123456789012:role/eks-microservice-adot-role",
  domain: process.env.DOMAIN ?? "api.example.com",
  appImage: process.env.APP_IMAGE ?? "nginxinc/nginx-unprivileged:stable",
};
