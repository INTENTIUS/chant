# Import round trip, byte level

Measured 2026-10-07 at chant 0.108.1 (5c45caae2).

| Target | Inputs | Byte-identical | Differ | Import failed | Build failed |
|---|---|---|---|---|---|
| CloudFormation | 20 | 0 | 3 | 1 | 16 |
| Kubernetes | 22 | 19 | 2 | 0 | 1 |

## Per input

| Input | Result | Reasons |
|---|---|---|
| aws/SQS__SQSStandardQueue.json | build-failed | output-of-a-bare-Ref: main.ts - error: stackOutput(ref): ref must be an attribute reference, an intrinsic wrapping one, or a literal string |
| aws/SQS__SQSFIFOQueue.yaml | build-failed | generated-source-does-not-compile: main.ts - error: Transform failed with 2 errors: |
| aws/SNS__SNSTopic.json | build-failed | output-of-a-bare-Ref: main.ts - error: stackOutput(ref): ref must be an attribute reference, an intrinsic wrapping one, or a literal string |
| aws/DynamoDB__DynamoDB_Table.json | different | field-dropped, section-dropped |
| aws/DynamoDB__DynamoDB_Secondary_Indexes.yaml | different | field-dropped, section-dropped |
| aws/S3__compliant-bucket.json | build-failed | Sub-embeds-a-resource: error: Cannot embed Declarable directly in Sub template. Use AttrRef instead. |
| aws/S3__compliant-static-website.yaml | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './storage' does not provide an export named 'cloudFrontLogsBucket' |
| aws/S3__S3_LambdaTrigger.json | build-failed | generated-file-references-missing-name: compute.ts - error: LambdaIAMRole is not defined |
| aws/Lambda__LambdaSample.yaml | build-failed | Sub-embeds-a-resource: error: Cannot embed Declarable directly in Sub template. Use AttrRef instead. |
| aws/VPC__FindInMapAZs.yaml | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './other' does not provide an export named 'defaultPrivateRoute1' |
| aws/VPC__VPC_With_Managed_NAT_And_Private_Subnet.json | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './other' does not provide an export named 'elasticIP0' |
| aws/EC2__EIP_With_Association.json | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './other' does not provide an export named 'eC2Instance' |
| aws/EC2__EC2InstanceWithSecurityGroupSample.yaml | build-failed | output-of-a-bare-Ref: main.ts - error: stackOutput(ref): ref must be an attribute reference, an intrinsic wrapping one, or a literal string |
| aws/RDS__RDS_MySQL_With_Read_Replica.json | build-failed | Sub-embeds-a-resource: error: Cannot embed Declarable directly in Sub template. Use AttrRef instead. |
| aws/RDS__RDS_with_DBParameterGroup.yaml | different | field-dropped, intrinsic-form, section-dropped |
| aws/APIGateway__apigateway_lambda_integration.yaml | import-failed | unknown-yaml-tag: error: Failed to parse template: YAMLException: unknown tag !<!Rain::Embed> (108:41) |
| aws/ElasticLoadBalancing__ELBStickinessSample.json | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './other' does not provide an export named 'eC2Instance1' |
| aws/CloudWatch__CloudWatch_Dashboard_NAT_FlowLogs.json | build-failed | Sub-embeds-a-resource: error: Cannot embed Declarable directly in Sub template. Use AttrRef instead. |
| aws/AutoScaling__AutoScalingRollingUpdates.yaml | build-failed | generated-file-references-missing-name: index.ts - error: The requested module './other' does not provide an export named 'describeHealthRole' |
| aws/ECS__ECS_Schedule_Example.yaml | build-failed | generated-file-references-missing-name: compute.ts - error: ECSCluster is not defined |
| k8s/controllers__nginx-deployment.yaml | identical |  |
| k8s/controllers__daemonset.yaml | identical |  |
| k8s/controllers__frontend.yaml | identical |  |
| k8s/controllers__job.yaml | identical |  |
| k8s/controllers__statefulset.yaml | identical |  |
| k8s/controllers__hpa-rs.yaml | different | api-version-changed |
| k8s/application__deployment.yaml | identical |  |
| k8s/application__guestbook__frontend-deployment.yaml | identical |  |
| k8s/application__guestbook__redis-leader-service.yaml | identical |  |
| k8s/application__mysql__mysql-statefulset.yaml | build-failed | build-check-error: error: [mysql] Container "mysql" in StatefulSet "mysql" has hardcoded value for sensitive env var "MYSQL_ALLOW_EMPTY_PASSWORD" — use secretKeyRef instead (k8s) |
| k8s/application__mysql__mysql-services.yaml | identical |  |
| k8s/application__zookeeper__zookeeper.yaml | identical |  |
| k8s/application__cassandra__cassandra-statefulset.yaml | identical |  |
| k8s/application__web__web.yaml | identical |  |
| k8s/application__php-apache.yaml | identical |  |
| k8s/configmap__immutable-configmap.yaml | identical |  |
| k8s/pods__simple-pod.yaml | identical |  |
| k8s/pods__init-containers.yaml | identical |  |
| k8s/pods__pod-with-node-affinity.yaml | identical |  |
| k8s/service__networking__minimal-ingress.yaml | identical |  |
| k8s/service__networking__network-policy-allow-all-egress.yaml | different | empty-value-collapsed |
| k8s/policy__quota.yaml | identical |  |

## Reasons an input differs

| Target | Reason | Where | Inputs affected |
|---|---|---|---|
| aws | field-dropped | Parameters, Resources | 3 |
| aws | section-dropped | Description, Metadata | 3 |
| aws | intrinsic-form | Outputs | 1 |
| k8s | api-version-changed |  | 1 |
| k8s | empty-value-collapsed |  | 1 |

## Reasons an input does not complete

| Target | Reason | Inputs affected |
|---|---|---|
| aws | generated-file-references-missing-name | 8 |
| aws | Sub-embeds-a-resource | 4 |
| aws | output-of-a-bare-Ref | 3 |
| aws | generated-source-does-not-compile | 1 |
| aws | unknown-yaml-tag | 1 |
| k8s | build-check-error | 1 |
