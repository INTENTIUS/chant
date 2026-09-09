# WAW-to-HCL fidelity: can the CloudFormation-shaped security rules read Terraform? (#2272)

Research probe against #2272. The aws lexicon owns 59 WAW rules, 26 of them carrying the
`AWS_SEC` authority, and every one reads a `CFResource` with `.Properties`
(`lexicons/aws/src/lint/post-synth/cf-refs.ts:17`). The terraform lexicon's entities carry
`props.body`, the raw `hcl2json` tree (`lexicons/terraform/src/hcl/parse.ts:52`). The question
is whether a shape bridge makes the first read the second.

Evidence is measured, not recalled. Terraform v1.15.8, `hashicorp/aws` v5.100.0, schema from
`terraform providers schema -json`. Ten HCL fixtures were parsed through the same
`@cdktf/hcl2json` the lexicon loads, mapped by a deliberately naive bridge, and fed to the
shipped rule functions themselves.

## The ten

Chosen from the `AWS_SEC` pool by two criteria: the fact is one an outside estate actually gets
wrong, and the resource type is common enough in real HCL to fire. The eight the issue named
are all here. WAW054 replaces a ninth because the issue's own sketch used ECR tag immutability
as the canonical rename, and WAW046 replaces a tenth because `container_definitions` is the
most widespread `jsonencode()` string in the provider and the translate class needs a second
witness beyond IAM. WAW038 (RDS `publicly_accessible`) and WAW043 (KMS `enable_key_rotation`)
were considered and dropped; both are clean renames, so including them would have moved the
count toward the bridge without changing anything measured below.

| Rule | Reads (CloudFormation) | Terraform, verified against the v5.100.0 schema | Verdict |
|---|---|---|---|
| WAW018 S3 public access block | `AWS::S3::Bucket` `Properties.PublicAccessBlockConfiguration.{BlockPublicAcls,BlockPublicPolicy,IgnorePublicAcls,RestrictPublicBuckets}`, flags an absent block or any explicit `false` | sibling resource `aws_s3_bucket_public_access_block`, four `bool` attributes, joined by `bucket` | restructure |
| WAW019 unrestricted ingress, sensitive port | `AWS::EC2::SecurityGroup` `Properties.SecurityGroupIngress[].{CidrIp,CidrIpv6,FromPort,ToPort}` plus standalone `AWS::EC2::SecurityGroupIngress` | three shapes: `aws_security_group.ingress`, which the schema types `set(object({cidr_blocks=list(string), ...}))`; `aws_security_group_rule` with `type="ingress"`; `aws_vpc_security_group_ingress_rule` with `cidr_ipv4`/`ip_protocol` | restructure |
| WAW020 IAM wildcard action | `PolicyDocument.Statement[].Action`, plus `AssumeRolePolicyDocument` and `Policies[].PolicyDocument`, as structured JSON | `aws_iam_policy.policy` and friends are `string`; in practice `jsonencode({...})`, `data.aws_iam_policy_document.x.json`, or a heredoc | translate |
| WAW021 RDS storage encryption | `StorageEncrypted === true` on `DBInstance` and `DBCluster` | `aws_db_instance.storage_encrypted`, `aws_rds_cluster.storage_encrypted`, both `bool` | rename |
| WAW025 SNS encryption | `"KmsMasterKeyId" in Properties` | `aws_sns_topic.kms_master_key_id`, `string` | rename |
| WAW026 SQS encryption | `SqsManagedSseEnabled === true` or `"KmsMasterKeyId" in Properties` | `aws_sqs_queue.sqs_managed_sse_enabled` (`bool`, optional and computed) or `kms_master_key_id` | rename |
| WAW028 EBS encryption | `AWS::EC2::Volume` `Encrypted === true` | `aws_ebs_volume.encrypted`, `bool` | rename |
| WAW042 S3 deny-non-TLS | `AWS::S3::BucketPolicy` `Properties.PolicyDocument.Statement[]`, looking for `Effect: Deny` with `Condition.Bool["aws:SecureTransport"]`, joined to the bucket by `findResourceRefs(Properties.Bucket)` | `aws_s3_bucket_policy.policy` is `string`, almost always `jsonencode()`; `bucket` is an interpolation, not a `Ref` | translate |
| WAW046 ECS plaintext secret | `ContainerDefinitions[].Environment[].Name` against a credential regex | `aws_ecs_task_definition.container_definitions` is a required `string`, written `jsonencode([...])` or `file("service.json")`, with camelCase keys inside | translate |
| WAW054 ECR tag immutability | `ImageTagMutability !== "IMMUTABLE"` | `aws_ecr_repository.image_tag_mutability`, `string`, same two values, defaults to `MUTABLE` | rename |

Count: five renames, two restructures, three translates, nothing absent. No majority, so the
rule #2272 set does not resolve on its own.

## Rename

Five of the ten are a snake-case-to-PascalCase lookup on a flat scalar, and all five survive a
mechanical bridge unchanged. Four of them are also correct.

WAW026 is the exception, and it is the one that matters. The spelling maps perfectly and the
semantics do not. `sqs_managed_sse_enabled` is `optional` and `computed` in the schema, and the
provider documentation says Terraform "will only perform drift detection of its value when
present in a configuration"; AWS enables SSE-SQS on new queues regardless. A queue that
declares neither attribute is encrypted, and the bridged rule reports it as not encrypted, on
every queue in the estate. The same failure mode waits under WAW028 (`aws_ebs_encryption_by_default`
makes an unset `encrypted` unknowable from config) and under any bridge that maps
`aws_rds_cluster_instance` onto `AWS::RDS::DBInstance`, since that resource's `storage_encrypted`
is computed-only and can never appear in a body.

## Restructure

WAW018's fact lives in a separate resource joined by an argument that `hcl2json` renders as the
string `"${aws_s3_bucket.assets.id}"`. Folding it back onto the bucket took twelve lines and
then the rule was correct, including reporting the two flags set to `false`. The residual error
runs the other way: the four flags default to `false` in Terraform, so an omitted flag is a real
violation, and the CF rule only looks for an explicit `false`. A bridge inherits that as a silent
false negative.

WAW019 does not recover so cheaply. `cidr_blocks` is a list where `CidrIp` is a scalar, the
newer `aws_vpc_security_group_ingress_rule` spells it `cidr_ipv4`, and `aws_security_group_rule`
needs `type` inspected before it is ingress at all. Against a fixture opening 22, 3389, 3306 and
5432 to the world across all three shapes, the bridged rule reported nothing.

## Translate

All three read a policy or definition document, and `hcl2json` hands back the call verbatim.
`policy = jsonencode({...})` parses to the single string `"${jsonencode({\n Version = ...})}"`.
`container_definitions` likewise. This is the point the issue predicted, and it holds: a rule
that reads a policy document cannot read one that has not been evaluated. Recovering it means an
HCL expression evaluator for at least `jsonencode`, `file()` and heredocs, plus a second reader
for `data.aws_iam_policy_document`, whose `statement[].actions` does arrive structurally and is
the one part of this class that is reachable today.

WAW042 is the worst case because it fires on absence. A bucket whose policy could not be
evaluated is indistinguishable from a bucket with no policy, and the rule's severity is `error`.

## What the bridge actually delivered

The naive bridge produced six findings on a root where every resource is correct. Two obvious
fixes, folding the public-access-block sibling and resolving the policy's `bucket` interpolation
to a `Ref`, cut that to two: WAW026 on the default-encrypted queue and WAW042 on a bucket whose
TLS-deny policy is right there in a `jsonencode()`. Two false positives across twelve resources.

On the violating fixtures the refined bridge caught WAW018, WAW021, WAW025, WAW026, WAW028 and
WAW054, and reported nothing at all for WAW019, WAW020 and WAW046, which is every wide-open
security group, every wildcard IAM policy and every plaintext credential in the set.

## Recommendation

Option B, native TF rules, and do not build the CF-shape bridge.

The count is five to five and does not decide it, so the measurement does. A bridge delivers
five rules and gets one of those five systematically wrong, and the five it delivers are exactly
the flat scalar lookups that a native rule against `props.body` writes in about ten lines each,
so nothing is bought. The rules where a bridge would have earned its cost, the three that read
policy documents and the two that read sibling resources and nested blocks, are precisely the
ones it cannot do without an HCL evaluator, a project larger than the rules it would enable.
Scaled to the 26 `AWS_SEC` rules, a bridge is a plausible route to roughly a dozen working
checks and two or three that are always wrong, and #2107's field note is that a tool with that
profile is ignored inside two weeks.

The deciding structural fact is one the four-row sketch did not name. WAW rules read a template
chant synthesized, where absence of a property is knowable, so they are two-valued: pass or
fail. A read of somebody else's HCL is three-valued, because absence may mean a sibling
resource, another root, a module input, a provider default, or an unevaluated function call.
Native rules can be written with that third answer; the WAW rules cannot be retrofitted with it
without changing what they mean for chant's own users.

Drift is the real cost of B, and the mitigation is a named fact table rather than shared code.

## Proposed issues

TF030, unrestricted ingress on a sensitive port. Fires across `aws_security_group.ingress`,
`aws_security_group_rule` with `type = "ingress"` and `aws_vpc_security_group_ingress_rule`,
and stays silent when the CIDR is an interpolation.

TF031, S3 bucket without a complete public access block. Fires when no
`aws_s3_bucket_public_access_block` in the same root module names the bucket, and when any of
the four flags is absent or `false`; silent when `bucket` is not a resolvable reference.

TF032, IAM wildcard action. Reads `data.aws_iam_policy_document` statements structurally and
reports `actions = ["*"]`; emits a report-only, never merge-worthy finding for a policy string
it cannot evaluate, rather than passing it.

TF033, encryption at rest, table-driven over `storage_encrypted`, `encrypted`,
`kms_master_key_id`, `sqs_managed_sse_enabled` and `image_tag_mutability`. An SQS queue setting
neither encryption attribute is not a finding, and `aws_rds_cluster_instance` is not checked.

TF034, the fact table. One source listing rule id, the fact, the CloudFormation path and the HCL
path, with a test that fails when an `AWS_SEC` WAW rule has no counterpart row and no recorded
reason for not having one.
