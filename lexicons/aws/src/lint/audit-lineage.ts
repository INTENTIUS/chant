/**
 * Prior art for these audit rules: the open-source tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts for
 * the registry, the relation vocabulary, and why this is credit rather than
 * authority. Kept by hand; the prior-art sweep (scripts/prior-art-sweep.ts) reports
 * when a credited tool's index no longer lists a rule cited here.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

export const awsAuditLineage: Record<string, Lineage[]> = {
  WAW010: [
    { tool: "cfn-lint", rule: "W3005", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#W3005", relation: "equivalent" },
  ],
  WAW011: [
    { tool: "cfn-lint", rule: "W2531", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#W2531", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_363", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
  ],
  WAW017: [
    { tool: "kics", rule: "Lambda Function Without Tags", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/8df8e857-bd59-44fa-9f4c-d77594b95b46/", relation: "extends" },
    { tool: "kics", rule: "EFS Without Tags", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/08e39832-5e42-4304-98a0-aa5b43393162/", relation: "extends" },
  ],
  WAW018: [
    { tool: "guard-rules-registry", rule: "S3_BUCKET_LEVEL_PUBLIC_ACCESS_PROHIBITED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_s3/s3_bucket_level_public_access_prohibited.guard", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_53", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "extends" },
    { tool: "checkov", rule: "CKV_AWS_56", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "extends" },
  ],
  WAW019: [
    { tool: "guard-rules-registry", rule: "RESTRICTED_INCOMING_TRAFFIC", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_ec2/restricted_common_ports.guard", relation: "overlaps" },
    { tool: "kics", rule: "EC2 Sensitive Port Is Publicly Exposed", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/494b03d3-bf40-4464-8524-7c56ad0700ed/", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_AWS_24", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "extends" },
  ],
  WAW020: [
    { tool: "checkov", rule: "CKV_AWS_63", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "cfn-nag", rule: "F4", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/IamPolicyWildcardActionRule.rb", relation: "overlaps" },
    { tool: "guard-rules-registry", rule: "IAM_ROLE_NO_WILDCARD_ACTIONS_ON_PERMISSIONS", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/iam/iam_role_no_wildcard_actions_on_permissions.guard", relation: "overlaps" },
  ],
  WAW021: [
    { tool: "cfn-nag", rule: "F27", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/RDSDBInstanceStorageEncryptedRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_16", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "RDS_STORAGE_ENCRYPTED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_rds/rds_storage_encrypted.guard", relation: "equivalent" },
  ],
  WAW022: [
    { tool: "cfn-nag", rule: "W89", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/LambdaFunctionInsideVPCRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_117", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "LAMBDA_INSIDE_VPC", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/lambda/lambda_inside_vpc.guard", relation: "equivalent" },
  ],
  WAW023: [
    { tool: "checkov", rule: "CKV_AWS_68", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "CloudFront Without WAF", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/0f139403-303f-467c-96bd-e717e6cfd62d/", relation: "equivalent" },
  ],
  WAW024: [
    { tool: "cfn-nag", rule: "W52", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/ElasticLoadBalancerV2AccessLoggingRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_91", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "ELBv2 ALB Access Log Disabled", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/c62e8b7d-1fdf-4050-ac4c-76ba9e1d9621/", relation: "equivalent" },
  ],
  WAW025: [
    { tool: "cfn-nag", rule: "W47", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/SnsTopicKmsMasterKeyIdRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_26", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "SNS_ENCRYPTED_KMS", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_sns/sns_encrypted_kms.guard", relation: "equivalent" },
  ],
  WAW026: [
    { tool: "checkov", rule: "CKV_AWS_27", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "SQS With SSE Disabled", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/12726829-93ed-4d51-9cbe-13423f4299e1/", relation: "equivalent" },
    { tool: "cfn-nag", rule: "W48", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/SqsQueueKmsMasterKeyIdRule.rb", relation: "overlaps" },
  ],
  WAW027: [
    { tool: "cfn-nag", rule: "W78", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/DynamoDBBackupRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_28", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "DYNAMODB_PITR_ENABLED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/dynamodb/dynamodb_pitr_enabled.guard", relation: "equivalent" },
  ],
  WAW028: [
    { tool: "cfn-nag", rule: "F1", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/EbsVolumeHasSseRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_3", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "ENCRYPTED_VOLUMES", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_ec2/encrypted_volumes.guard", relation: "equivalent" },
  ],
  WAW029: [
    { tool: "cfn-lint", rule: "E3005", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3005", relation: "equivalent" },
  ],
  WAW032: [
    { tool: "checkov", rule: "CKV_AWS_97", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "EFS Volume With Disabled Transit Encryption", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/c1282e03-b285-4637-aee7-eefe3a7bb658/", relation: "equivalent" },
  ],
  WAW038: [
    { tool: "cfn-nag", rule: "F22", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/RDSInstancePubliclyAccessibleRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_17", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "RDS DB Instance Publicly Accessible", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/de38e1d5-54cb-4111-a868-6f7722695007/", relation: "equivalent" },
  ],
  WAW039: [
    { tool: "cfn-nag", rule: "W75", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/RDSInstanceBackupRetentionPeriodRule.rb", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "DB_INSTANCE_BACKUP_ENABLED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_rds/db_instance_backup_enabled.guard", relation: "equivalent" },
    { tool: "kics", rule: "RDS With Backup Disabled", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/8c415f6f-7b90-4a27-a44a-51047e1506f9/", relation: "equivalent" },
  ],
  WAW040: [
    { tool: "cfn-nag", rule: "F80", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/RDSInstanceDeletionProtectionRule.rb", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "RDS_INSTANCE_DELETION_PROTECTION_ENABLED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_rds/rds_instance_deletion_protection_enabled.guard", relation: "equivalent" },
    { tool: "kics", rule: "RDS DB Instance With Deletion Protection Disabled", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/2c161e58-cb52-454f-abea-6470c37b5e6e/", relation: "equivalent" },
  ],
  WAW042: [
    { tool: "guard-rules-registry", rule: "S3_BUCKET_SSL_REQUESTS_ONLY", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_s3/s3_bucket_ssl_requests_only.guard", relation: "equivalent" },
    { tool: "kics", rule: "S3 Bucket Without SSL In Write Actions", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/38c64e76-c71e-4d92-a337-60174d1de1c9/", relation: "overlaps" },
  ],
  WAW043: [
    { tool: "cfn-nag", rule: "F19", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/KMSKeyRotationRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_7", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "CMK_BACKING_KEY_ROTATION_ENABLED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/aws_kms/cmk_backing_key_rotation_enabled.guard", relation: "equivalent" },
  ],
  WAW044: [
    { tool: "checkov", rule: "CKV_AWS_2", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "overlaps" },
    { tool: "cfn-nag", rule: "W56", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/ElasticLoadBalancerV2ListenerProtocolRule.rb", relation: "overlaps" },
  ],
  WAW045: [
    { tool: "cfn-nag", rule: "W55", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/ElasticLoadBalancerV2ListenerSslPolicyRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_103", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "ELBV2_LISTENER_SSL_POLICY_RULE", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/elastic_load_balancing_v2/elbv2_listener_ssl_policy_rule.guard", relation: "equivalent" },
  ],
  WAW049: [
    { tool: "cfn-nag", rule: "W2", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/SecurityGroupIngressOpenToWorldRule.rb", relation: "overlaps" },
    { tool: "guard-rules-registry", rule: "EC2_SECURITY_GROUP_INGRESS_OPEN_TO_WORLD_RULE", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/amazon_ec2/ec2_security_group_ingress_open_to_world_rule.guard", relation: "overlaps" },
    { tool: "kics", rule: "Unrestricted Security Group Ingress", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/4a1e6b34-1008-4e61-a5f2-1f7c276f8d14/", relation: "overlaps" },
  ],
  WAW052: [
    { tool: "cfn-nag", rule: "F78", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/CognitoUserPoolMfaConfigurationOnorOptionalRule.rb", relation: "overlaps" },
    { tool: "guard-rules-registry", rule: "COGNITO_USER_POOL_MFA_CONFIGURATION_RULE", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/aws_cognito/cognito_user_pool_mfa_configuration_rule.guard", relation: "overlaps" },
    { tool: "kics", rule: "Cognito UserPool Without MFA", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/74a18d1a-cf02-4a31-8791-ed0967ad7fdc/", relation: "overlaps" },
  ],
  WAW053: [
    { tool: "cfn-nag", rule: "W79", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/ECRRepositoryScanOnPushRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_163", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "ECR_REPO_SCAN_ON_PUSH", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/aws_ecr/ecr_repo_scan_on_push_rule.guard", relation: "equivalent" },
  ],
  WAW054: [
    { tool: "checkov", rule: "CKV_AWS_51", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "kics", rule: "ECR Image Tag Not Immutable", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/33f41d31-86b1-46a4-81f7-9c9a671f59ac/", relation: "equivalent" },
  ],
  WAW055: [
    { tool: "cfn-nag", rule: "W86", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/LogsLogGroupRetentionRule.rb", relation: "equivalent" },
    { tool: "checkov", rule: "CKV_AWS_66", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "equivalent" },
    { tool: "guard-rules-registry", rule: "CW_LOGGROUP_RETENTION_PERIOD_CHECK", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/cloudwatch/cw_loggroup_retention_period_check.guard", relation: "equivalent" },
  ],
  WAW058: [
    { tool: "guard-rules-registry", rule: "MULTI_REGION_CLOUD_TRAIL_ENABLED", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/cloudtrail/multi_region_cloud_trail_enabled.guard", relation: "overlaps" },
    { tool: "checkov", rule: "CKV_AWS_67", url: "https://www.checkov.io/5.Policy%20Index/cloudformation.html", relation: "overlaps" },
    { tool: "kics", rule: "CloudTrail Logging Disabled", url: "https://docs.kics.io/latest/queries/cloudformation-queries/aws/5c0b06d5-b7a4-484c-aeb0-75a836269ff0/", relation: "overlaps" },
  ],
  WAW059: [
    { tool: "cfn-nag", rule: "W12", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/IamPolicyWildcardResourceRule.rb", relation: "overlaps" },
    { tool: "cfn-nag", rule: "W11", url: "https://github.com/stelligent/cfn_nag/blob/master/lib/cfn-nag/custom_rules/IamRoleWildcardResourceOnPermissionsPolicyRule.rb", relation: "overlaps" },
    { tool: "guard-rules-registry", rule: "IAM_POLICYDOCUMENT_NO_WILDCARD_RESOURCE", url: "https://github.com/aws-cloudformation/aws-guard-rules-registry/blob/main/rules/aws/iam/iam_policydocument_no_wildcard_resource.guard", relation: "overlaps" },
  ],
  WAW061: [
    { tool: "cfn-lint", rule: "E3059", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3059", relation: "equivalent" },
  ],
  WAW062: [
    { tool: "cfn-lint", rule: "E3019", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E3019", relation: "overlaps" },
  ],
  WAW069: [
    { tool: "cfn-lint", rule: "E8002", url: "https://github.com/aws-cloudformation/cfn-lint/blob/main/docs/rules.md#E8002", relation: "equivalent" },
  ],
};
