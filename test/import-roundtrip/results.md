# Import round trip, byte level

Measured 2026-10-08 at chant 0.109.0 (865d17791).

| Target | Inputs | Byte-identical | Differ | Import failed | Build failed |
|---|---|---|---|---|---|
| CloudFormation | 20 | 9 | 10 | 1 | 0 |
| Kubernetes | 22 | 22 | 0 | 0 | 0 |

Built with these checks off, because the inputs themselves trip them: WAW049, WAW021, WAW039, WAW042 (CloudFormation), WK8005 (Kubernetes).

## Per input

| Input | Result | Reasons |
|---|---|---|
| aws/SQS__SQSStandardQueue.json | different | section-dropped |
| aws/SQS__SQSFIFOQueue.yaml | different | section-dropped |
| aws/SNS__SNSTopic.json | different | field-dropped, section-dropped |
| aws/DynamoDB__DynamoDB_Table.json | identical |  |
| aws/DynamoDB__DynamoDB_Secondary_Indexes.yaml | identical |  |
| aws/S3__compliant-bucket.json | different | field-added |
| aws/S3__compliant-static-website.yaml | different | field-added |
| aws/S3__S3_LambdaTrigger.json | different | value-changed |
| aws/Lambda__LambdaSample.yaml | identical |  |
| aws/VPC__FindInMapAZs.yaml | different | field-added |
| aws/VPC__VPC_With_Managed_NAT_And_Private_Subnet.json | different | intrinsic-form |
| aws/EC2__EIP_With_Association.json | identical |  |
| aws/EC2__EC2InstanceWithSecurityGroupSample.yaml | identical |  |
| aws/RDS__RDS_MySQL_With_Read_Replica.json | identical |  |
| aws/RDS__RDS_with_DBParameterGroup.yaml | identical |  |
| aws/APIGateway__apigateway_lambda_integration.yaml | import-failed | unknown-yaml-tag: error: Failed to parse template: YAMLException: unknown tag !<!Rain::Embed> (108:41) |
| aws/ElasticLoadBalancing__ELBStickinessSample.json | different | intrinsic-form |
| aws/CloudWatch__CloudWatch_Dashboard_NAT_FlowLogs.json | identical |  |
| aws/AutoScaling__AutoScalingRollingUpdates.yaml | different | intrinsic-form |
| aws/ECS__ECS_Schedule_Example.yaml | identical |  |
| k8s/controllers__nginx-deployment.yaml | identical |  |
| k8s/controllers__daemonset.yaml | identical |  |
| k8s/controllers__frontend.yaml | identical |  |
| k8s/controllers__job.yaml | identical |  |
| k8s/controllers__statefulset.yaml | identical |  |
| k8s/controllers__hpa-rs.yaml | identical |  |
| k8s/application__deployment.yaml | identical |  |
| k8s/application__guestbook__frontend-deployment.yaml | identical |  |
| k8s/application__guestbook__redis-leader-service.yaml | identical |  |
| k8s/application__mysql__mysql-statefulset.yaml | identical |  |
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
| k8s/service__networking__network-policy-allow-all-egress.yaml | identical |  |
| k8s/policy__quota.yaml | identical |  |

## Reasons an input differs

| Target | Reason | Where | Inputs affected |
|---|---|---|---|
| aws | section-dropped | Conditions, Mappings | 3 |
| aws | field-added | AWSTemplateFormatVersion | 3 |
| aws | intrinsic-form | Resources | 3 |
| aws | field-dropped | Resources | 1 |
| aws | value-changed | Resources | 1 |

## Reasons an input does not complete

| Target | Reason | Inputs affected |
|---|---|---|
| aws | unknown-yaml-tag | 1 |
