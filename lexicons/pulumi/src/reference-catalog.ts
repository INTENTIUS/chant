/**
 * How the resources of a Pulumi stack name each other, as a `ReferenceCatalog`
 * over the aws, gcp, azure and kubernetes providers (#5330).
 *
 * `chant workspace graph` runs each lexicon's catalog over the composed
 * nodes (`packages/core/src/workspace/catalog-edges.ts`), and behold keeps
 * its own name matcher for a lexicon that has none. This is the pulumi
 * lexicon's, shaped like the terraform lexicon's
 * (`../../terraform/src/behaviour/reference-catalog.ts`): rules grouped by
 * the relation they produce, a short list of kinds known to reference
 * nothing, and `identities` for what else names a kind.
 *
 * ## Shape
 *
 * A node's kind is the Pulumi type token (`aws:ec2/subnet:Subnet`), which is
 * what the member read gives it (`./workspace-member.ts`). Its attrs are the
 * resource's inputs as the stack export records them, in Pulumi's camelCase
 * (`vpcId`, `networkConfiguration.subnets[]`), plus an `outputs` object
 * holding its `id` and top-level string outputs (`outputs.arn`,
 * `outputs.selfLink`), from `./reference-props.ts`. An export holds resolved
 * values, so a reference reads as the physical id, ARN or name of its
 * target, and the rules match that against the target's identities.
 *
 * ## Ids, ARNs and names
 *
 * Every target is identified by `outputs.id`, `outputs.arn`, `outputs.name`
 * and the `name` input, with the extra names its provider uses
 * ({@link EXTRA_IDS}): a bucket's `bucket`, a service account's `accountId`
 * and `email`, a Kubernetes object's `metadata.name`. A rule names the kind
 * it expects, so a name that two kinds share joins neither to the wrong one.
 *
 * ## Targets in other members
 *
 * A reference can name a resource that another member declares. The
 * terraform lexicon identifies a few kinds by name (`aws_iam_role`,
 * `aws_eks_cluster`, `aws_secretsmanager_secret`, `google_service_account`,
 * `google_container_cluster`, `google_secret_manager_secret`,
 * `azurerm_kubernetes_cluster`), and the k8s lexicon identifies its objects
 * by `metadata.name`. A rule toward one of those has a second rule for the
 * other lexicon's kind, under the same id, so a value that names a node of
 * either is found and the other is not reported as missing. A Terraform
 * block that names no identity (a VPC's id before it is applied) is not
 * reachable by value; the edge appears once the id is on the node.
 *
 * ## Kubernetes
 *
 * A name is unique only inside its namespace. The namespaced kinds are
 * `scopes` on `metadata.namespace`, and a pod spec's references to a service
 * account, a ConfigMap or a Secret are `join` rules that look the name up in
 * the holder's namespace across members, so a Deployment in this lexicon
 * reaches a ServiceAccount of the k8s lexicon in the same namespace. A
 * namespaced object also has an `in namespace` containment toward its
 * `Namespace`, optional because most namespaces are created elsewhere.
 *
 * ## What "no rule" means
 *
 * A kind with no rule produces no edges. {@link REFERENCES_NOTHING} lists
 * kinds looked at and found to hold no argument that identifies another
 * resource, so {@link isUnresolvedKind} separates "nobody wrote a rule" from
 * "there is nothing to find".
 *
 * ## Adding a rule
 *
 * A rule is one call to `rule` in the list for its provider: holder kind,
 * input path, target kind or kinds, label. A target kind that others name
 * goes in {@link EXTRA_IDS} or {@link NAMED_KINDS}. The test "each rule draws
 * its edge" covers a new rule with no test of its own.
 */
import { readPath, type IdentityRule, type JoinedRef, type ReferenceCatalog, type RefRule, type ScopeRule } from "@intentius/chant/graph-refs";

type Rel = RefRule["relation"];

/** Terraform kinds the terraform lexicon identifies by name, keyed by the Pulumi kind that is the same resource. */
const TERRAFORM_ALIAS: Readonly<Record<string, string>> = {
  "aws:iam/role:Role": "aws_iam_role",
  "aws:eks/cluster:Cluster": "aws_eks_cluster",
  "aws:secretsmanager/secret:Secret": "aws_secretsmanager_secret",
  "gcp:serviceaccount/account:Account": "google_service_account",
  "gcp:container/cluster:Cluster": "google_container_cluster",
  "gcp:secretmanager/secret:Secret": "google_secret_manager_secret",
  "azure:containerservice/kubernetesCluster:KubernetesCluster": "azurerm_kubernetes_cluster",
};

/** The k8s lexicon's kind for a Pulumi Kubernetes kind. */
const K8S_ALIAS: Readonly<Record<string, string>> = {
  "kubernetes:core/v1:Namespace": "K8s::Core::Namespace",
  "kubernetes:core/v1:ServiceAccount": "K8s::Core::ServiceAccount",
  "kubernetes:core/v1:ConfigMap": "K8s::Core::ConfigMap",
  "kubernetes:core/v1:Secret": "K8s::Core::Secret",
};

/** A Pulumi kind and the kinds of other lexicons that stand for the same resource, the Pulumi kind last: a missing target is reported under the last rule of its id. */
const targets = (kind: string): string[] => [...[TERRAFORM_ALIAS[kind], K8S_ALIAS[kind]].filter((k): k is string => k !== undefined), kind];

const rule = (from: string, path: string, target: string, label: string, relation: Rel = "reference", viaAttr?: string): RefRule[] =>
  targets(target).map((targetKind) => ({ from, path, targetKind, relation, label, ...(viaAttr ? { viaAttr } : {}) }));

const containment = (from: string, path: string, target: string, label: string, viaAttr?: string): RefRule[] => rule(from, path, target, label, "containment", viaAttr);

/** `rule` for a value that names no node most of the time (an env var, a free-form name). */
const maybe = (from: string, path: string, target: string, label: string): RefRule[] => rule(from, path, target, label).map((r) => ({ ...r, optional: true }));

// ── aws ──

const EC2 = (t: string) => `aws:ec2/${t[0].toLowerCase()}${t.slice(1)}:${t}`;
const VPC = EC2("Vpc");
const SUBNET = EC2("Subnet");
const SECURITY_GROUP = EC2("SecurityGroup");
const ROUTE_TABLE = EC2("RouteTable");
const INTERNET_GATEWAY = EC2("InternetGateway");
const NAT_GATEWAY = EC2("NatGateway");
const EIP = EC2("Eip");
const INSTANCE = EC2("Instance");
const NETWORK_INTERFACE = EC2("NetworkInterface");
const LB = "aws:lb/loadBalancer:LoadBalancer";
const TARGET_GROUP = "aws:lb/targetGroup:TargetGroup";
const ECS_CLUSTER = "aws:ecs/cluster:Cluster";
const ECS_TASK = "aws:ecs/taskDefinition:TaskDefinition";
const IAM_ROLE = "aws:iam/role:Role";
const IAM_POLICY = "aws:iam/policy:Policy";
const INSTANCE_PROFILE = "aws:iam/instanceProfile:InstanceProfile";
const LAMBDA = "aws:lambda/function:Function";
const S3_BUCKET = "aws:s3/bucket:Bucket";
const S3_BUCKET_V2 = "aws:s3/bucketV2:BucketV2";
const ROUTE53_ZONE = "aws:route53/zone:Zone";
const EKS_CLUSTER = "aws:eks/cluster:Cluster";
const RDS_SUBNET_GROUP = "aws:rds/subnetGroup:SubnetGroup";
const RDS_CLUSTER = "aws:rds/cluster:Cluster";
const SQS_QUEUE = "aws:sqs/queue:Queue";
const SNS_TOPIC = "aws:sns/topic:Topic";
const KMS_KEY = "aws:kms/key:Key";
const LOG_GROUP = "aws:cloudwatch/logGroup:LogGroup";

/** A bucket is `Bucket` or `BucketV2`; a rule toward one has the same rule toward the other. */
const bucketRules = (from: string, path: string, label: string, relation: Rel = "reference"): RefRule[] =>
  [S3_BUCKET, S3_BUCKET_V2].flatMap((b) => rule(from, path, b, label, relation));

const awsRules: RefRule[] = [
  // containment
  ...[SUBNET, SECURITY_GROUP, ROUTE_TABLE, INTERNET_GATEWAY, "aws:lb/targetGroup:TargetGroup", "aws:ec2/vpcEndpoint:VpcEndpoint"].flatMap((k) => containment(k, "vpcId", VPC, "in VPC")),
  ...containment(INSTANCE, "subnetId", SUBNET, "in subnet", "subnetId"),
  ...[NAT_GATEWAY, NETWORK_INTERFACE].flatMap((k) => containment(k, "subnetId", SUBNET, "in subnet")),
  ...[LB, "aws:rds/subnetGroup:SubnetGroup", "aws:elasticache/subnetGroup:SubnetGroup", "aws:eks/nodeGroup:NodeGroup"].flatMap((k) =>
    containment(k, k === LB ? "subnets[]" : "subnetIds[]", SUBNET, "in subnet"),
  ),
  ...containment(LAMBDA, "vpcConfig.subnetIds[]", SUBNET, "in subnet"),
  ...containment("aws:ecs/service:Service", "networkConfiguration.subnets[]", SUBNET, "in subnet"),
  ...containment(EKS_CLUSTER, "vpcConfig.subnetIds[]", SUBNET, "in subnet"),
  ...[RDS_CLUSTER, "aws:rds/instance:Instance"].flatMap((k) => containment(k, "dbSubnetGroupName", RDS_SUBNET_GROUP, "in subnet group")),

  // references
  ...rule(INSTANCE, "vpcSecurityGroupIds[]", SECURITY_GROUP, "sg", "reference", "vpcSecurityGroupIds"),
  ...rule(INSTANCE, "iamInstanceProfile", INSTANCE_PROFILE, "as"),
  ...[NETWORK_INTERFACE, LB].flatMap((k) => rule(k, "securityGroups[]", SECURITY_GROUP, "sg")),
  ...rule(LAMBDA, "vpcConfig.securityGroupIds[]", SECURITY_GROUP, "sg"),
  ...[RDS_CLUSTER, "aws:rds/instance:Instance"].flatMap((k) => rule(k, "vpcSecurityGroupIds[]", SECURITY_GROUP, "sg")),
  ...rule("aws:ecs/service:Service", "networkConfiguration.securityGroups[]", SECURITY_GROUP, "sg"),
  ...rule("aws:ec2/securityGroupRule:SecurityGroupRule", "securityGroupId", SECURITY_GROUP, "rule on", "reference", "securityGroupId"),
  ...rule("aws:ec2/securityGroupRule:SecurityGroupRule", "sourceSecurityGroupId", SECURITY_GROUP, "allows"),
  ...rule("aws:lb/listener:Listener", "loadBalancerArn", LB, "on"),
  ...rule("aws:lb/listener:Listener", "defaultActions[].targetGroupArn", TARGET_GROUP, "forwards to"),
  ...rule("aws:lb/targetGroupAttachment:TargetGroupAttachment", "targetGroupArn", TARGET_GROUP, "in group"),
  ...[INSTANCE, LAMBDA].flatMap((k) => maybe("aws:lb/targetGroupAttachment:TargetGroupAttachment", "targetId", k, "targets")),
  ...rule("aws:ec2/route:Route", "routeTableId", ROUTE_TABLE, "in table", "reference", "routeTableId"),
  ...rule("aws:ec2/route:Route", "gatewayId", INTERNET_GATEWAY, "via", "reference", "gatewayId"),
  ...rule("aws:ec2/route:Route", "natGatewayId", NAT_GATEWAY, "via"),
  ...rule("aws:ec2/routeTableAssociation:RouteTableAssociation", "subnetId", SUBNET, "associates", "reference", "subnetId"),
  ...rule("aws:ec2/routeTableAssociation:RouteTableAssociation", "routeTableId", ROUTE_TABLE, "to table", "reference", "routeTableId"),
  ...rule("aws:ec2/internetGatewayAttachment:InternetGatewayAttachment", "internetGatewayId", INTERNET_GATEWAY, "attaches"),
  ...rule("aws:ec2/internetGatewayAttachment:InternetGatewayAttachment", "vpcId", VPC, "to VPC"),
  ...rule(NAT_GATEWAY, "allocationId", EIP, "uses"),
  ...rule("aws:ecs/service:Service", "cluster", ECS_CLUSTER, "in cluster"),
  ...rule("aws:ecs/service:Service", "taskDefinition", ECS_TASK, "runs"),
  ...rule("aws:ecs/service:Service", "loadBalancers[].targetGroupArn", TARGET_GROUP, "registered in"),
  ...[ "executionRoleArn", "taskRoleArn" ].flatMap((p) => rule(ECS_TASK, p, IAM_ROLE, "as")),
  ...rule(LAMBDA, "role", IAM_ROLE, "as"),
  ...rule(EKS_CLUSTER, "roleArn", IAM_ROLE, "as"),
  ...rule("aws:eks/nodeGroup:NodeGroup", "clusterName", EKS_CLUSTER, "in cluster"),
  ...rule("aws:eks/nodeGroup:NodeGroup", "nodeRoleArn", IAM_ROLE, "as"),
  ...rule("aws:iam/rolePolicyAttachment:RolePolicyAttachment", "role", IAM_ROLE, "on"),
  ...rule("aws:iam/rolePolicyAttachment:RolePolicyAttachment", "policyArn", IAM_POLICY, "attaches"),
  ...rule("aws:iam/rolePolicy:RolePolicy", "role", IAM_ROLE, "on"),
  ...rule(INSTANCE_PROFILE, "role", IAM_ROLE, "holds"),
  ...["aws:s3/bucketPolicy:BucketPolicy", "aws:s3/bucketAclV2:BucketAclV2", "aws:s3/bucketVersioningV2:BucketVersioningV2", "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock", "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2", "aws:s3/bucketOwnershipControls:BucketOwnershipControls"].flatMap((k) =>
    bucketRules(k, "bucket", "setting on"),
  ),
  ...rule("aws:sqs/queuePolicy:QueuePolicy", "queueUrl", SQS_QUEUE, "grant on"),
  ...rule("aws:sns/topicSubscription:TopicSubscription", "topic", SNS_TOPIC, "on"),
  ...[LOG_GROUP, SNS_TOPIC].flatMap((k) => rule(k, k === LOG_GROUP ? "kmsKeyId" : "kmsMasterKeyId", KMS_KEY, "encrypted with")),
  ...rule("aws:route53/record:Record", "zoneId", ROUTE53_ZONE, "in zone"),
  ...rule("aws:secretsmanager/secretVersion:SecretVersion", "secretId", "aws:secretsmanager/secret:Secret", "version of"),
  ...rule("aws:lambda/permission:Permission", "function", LAMBDA, "grant on"),
  ...rule("aws:lambda/eventSourceMapping:EventSourceMapping", "functionName", LAMBDA, "invokes"),
  ...rule("aws:lambda/eventSourceMapping:EventSourceMapping", "eventSourceArn", SQS_QUEUE, "drains"),
  // A bucket's regional domain name or a load balancer's DNS name; no target kind.
  { from: "aws:cloudfront/distribution:Distribution", path: "origins[].domainName", relation: "reference", label: "origin" },
];

// ── gcp ──

const GCP_NETWORK = "gcp:compute/network:Network";
const GCP_SUBNETWORK = "gcp:compute/subnetwork:Subnetwork";
const GCP_INSTANCE = "gcp:compute/instance:Instance";
const GCP_CLUSTER = "gcp:container/cluster:Cluster";
const GCP_SERVICE_ACCOUNT = "gcp:serviceaccount/account:Account";
const GCP_SECRET = "gcp:secretmanager/secret:Secret";
const GCP_BUCKET = "gcp:storage/bucket:Bucket";

const gcpRules: RefRule[] = [
  ...containment(GCP_SUBNETWORK, "network", GCP_NETWORK, "in network"),
  ...containment(GCP_INSTANCE, "networkInterfaces[].subnetwork", GCP_SUBNETWORK, "in subnet"),
  ...rule(GCP_INSTANCE, "networkInterfaces[].network", GCP_NETWORK, "on network"),
  ...rule(GCP_INSTANCE, "serviceAccount.email", GCP_SERVICE_ACCOUNT, "as"),
  ...rule(GCP_CLUSTER, "network", GCP_NETWORK, "on network"),
  ...containment(GCP_CLUSTER, "subnetwork", GCP_SUBNETWORK, "in subnet"),
  ...rule("gcp:container/nodePool:NodePool", "cluster", GCP_CLUSTER, "in cluster"),
  ...rule("gcp:container/nodePool:NodePool", "nodeConfig.serviceAccount", GCP_SERVICE_ACCOUNT, "as"),
  ...rule("gcp:compute/firewall:Firewall", "network", GCP_NETWORK, "on network"),
  ...rule("gcp:compute/router:Router", "network", GCP_NETWORK, "on network"),
  ...rule("gcp:secretmanager/secretVersion:SecretVersion", "secret", GCP_SECRET, "version of"),
  ...rule("gcp:secretmanager/secretIamMember:SecretIamMember", "secretId", GCP_SECRET, "grant on"),
  ...rule("gcp:storage/bucketIAMMember:BucketIAMMember", "bucket", GCP_BUCKET, "grant on"),
  ...rule("gcp:storage/bucketIAMBinding:BucketIAMBinding", "bucket", GCP_BUCKET, "grant on"),
  ...rule("gcp:storage/bucketObject:BucketObject", "bucket", GCP_BUCKET, "in bucket"),
  ...rule("gcp:serviceaccount/iAMMember:IAMMember", "serviceAccountId", GCP_SERVICE_ACCOUNT, "grant on"),
  ...rule("gcp:serviceaccount/key:Key", "serviceAccountId", GCP_SERVICE_ACCOUNT, "key of"),
];

// ── azure (azure-native and the classic azure provider) ──

/** The kinds of one Azure provider that the rules join, and the input each reads. */
interface AzureFamily {
  group: string;
  vnet: string;
  subnet: string;
  aks: string;
  nic: string;
  nsg: string;
  /** Other kinds that sit in a resource group. */
  inGroup: readonly string[];
  /** Where a subnet names its VNet. */
  subnetVnet: string;
  aksSubnet: string;
  nicSubnet: string;
  nicNsg: string;
}

const AZURE_NATIVE: AzureFamily = {
  group: "azure-native:resources:ResourceGroup",
  vnet: "azure-native:network:VirtualNetwork",
  subnet: "azure-native:network:Subnet",
  aks: "azure-native:containerservice:ManagedCluster",
  nic: "azure-native:network:NetworkInterface",
  nsg: "azure-native:network:NetworkSecurityGroup",
  inGroup: ["azure-native:storage:StorageAccount", "azure-native:keyvault:Vault", "azure-native:network:PublicIPAddress", "azure-native:compute:VirtualMachine", "azure-native:web:WebApp", "azure-native:app:ContainerApp", "azure-native:app:ManagedEnvironment", "azure-native:containerregistry:Registry"],
  subnetVnet: "virtualNetworkName",
  aksSubnet: "agentPoolProfiles[].vnetSubnetID",
  nicSubnet: "ipConfigurations[].subnet.id",
  nicNsg: "networkSecurityGroup.id",
};

const AZURE_CLASSIC: AzureFamily = {
  group: "azure:core/resourceGroup:ResourceGroup",
  vnet: "azure:network/virtualNetwork:VirtualNetwork",
  subnet: "azure:network/subnet:Subnet",
  aks: "azure:containerservice/kubernetesCluster:KubernetesCluster",
  nic: "azure:network/networkInterface:NetworkInterface",
  nsg: "azure:network/networkSecurityGroup:NetworkSecurityGroup",
  inGroup: ["azure:storage/account:Account", "azure:keyvault/keyVault:KeyVault", "azure:network/publicIp:PublicIp", "azure:compute/linuxVirtualMachine:LinuxVirtualMachine", "azure:containerservice/registry:Registry"],
  subnetVnet: "virtualNetworkName",
  aksSubnet: "defaultNodePool.vnetSubnetId",
  nicSubnet: "ipConfigurations[].subnetId",
  nicNsg: "networkSecurityGroupId",
};

const AZURE_FAMILIES = [AZURE_NATIVE, AZURE_CLASSIC];

function azureRulesOf(f: AzureFamily): RefRule[] {
  return [
    // Both providers name the group by `resourceGroupName`.
    ...[f.vnet, f.subnet, f.aks, f.nic, f.nsg, ...f.inGroup].flatMap((k) => containment(k, "resourceGroupName", f.group, "in resource group")),
    ...containment(f.subnet, f.subnetVnet, f.vnet, "in VNet"),
    ...containment(f.aks, f.aksSubnet, f.subnet, "in subnet"),
    ...containment(f.nic, f.nicSubnet, f.subnet, "in subnet"),
    ...rule(f.nic, f.nicNsg, f.nsg, "sg"),
  ];
}

const azureRules: RefRule[] = AZURE_FAMILIES.flatMap(azureRulesOf);

// ── kubernetes ──

/** Workload kinds and the path to their pod spec. */
const POD_SPECS: ReadonlyArray<readonly [kind: string, podSpec: string]> = [
  ["kubernetes:core/v1:Pod", "spec"],
  ["kubernetes:apps/v1:Deployment", "spec.template.spec"],
  ["kubernetes:apps/v1:StatefulSet", "spec.template.spec"],
  ["kubernetes:apps/v1:DaemonSet", "spec.template.spec"],
  ["kubernetes:batch/v1:Job", "spec.template.spec"],
  ["kubernetes:batch/v1:CronJob", "spec.jobTemplate.spec.template.spec"],
];

const NAMESPACE = "kubernetes:core/v1:Namespace";
const SERVICE_ACCOUNT = "kubernetes:core/v1:ServiceAccount";
const CONFIG_MAP = "kubernetes:core/v1:ConfigMap";
const SECRET = "kubernetes:core/v1:Secret";

/** Kinds that sit in a namespace, so `metadata.namespace` places them. */
const NAMESPACED_KINDS = [
  ...POD_SPECS.map(([kind]) => kind),
  "kubernetes:core/v1:Service",
  CONFIG_MAP,
  SECRET,
  SERVICE_ACCOUNT,
  "kubernetes:core/v1:PersistentVolumeClaim",
  "kubernetes:networking.k8s.io/v1:Ingress",
  "kubernetes:rbac.authorization.k8s.io/v1:Role",
  "kubernetes:rbac.authorization.k8s.io/v1:RoleBinding",
];

/** Kinds other objects name by `metadata.name`. */
const NAMED_KINDS = [...NAMESPACED_KINDS, NAMESPACE];

const first = (holder: { attrs?: Record<string, unknown> }, path: string): string | undefined => readPath(holder.attrs, path).find((v) => v !== "");

/**
 * A pod spec's reference to a namespaced object, by name: the name is looked
 * up inside the holder's `metadata.namespace` in any member, so the object
 * can be this lexicon's or the k8s lexicon's. A holder that names no
 * namespace looks inside its own scope.
 */
function namespacedRule(from: string, path: string, target: string, label: string): RefRule[] {
  return targets(target).map((targetKind) => ({
    from,
    path,
    targetKind,
    relation: "reference" as const,
    label,
    join(holder, find): JoinedRef[] {
      const namespace = first(holder, "metadata.namespace");
      return [...new Set(readPath(holder.attrs, path))]
        .filter((name) => name !== "")
        .map((name) => ({ value: name, targets: (namespace === undefined ? find(name) : find(name, namespace)).filter((n) => n.kind === targetKind) }));
    },
  }));
}

/** What a pod spec names: its service account, mounted config and secrets, and env sources. */
function podSpecRules(kind: string, p: string): RefRule[] {
  return [
    ...namespacedRule(kind, `${p}.serviceAccountName`, SERVICE_ACCOUNT, "runs as"),
    ...namespacedRule(kind, `${p}.volumes[].configMap.name`, CONFIG_MAP, "mounts"),
    ...namespacedRule(kind, `${p}.volumes[].secret.secretName`, SECRET, "mounts"),
    ...namespacedRule(kind, `${p}.containers[].envFrom[].configMapRef.name`, CONFIG_MAP, "env from"),
    ...namespacedRule(kind, `${p}.containers[].envFrom[].secretRef.name`, SECRET, "env from"),
    // An env var whose value is a bucket's literal name (behold#166).
    ...[S3_BUCKET, S3_BUCKET_V2].flatMap((b) => maybe(kind, `${p}.containers[].env[].value`, b, "uses bucket")),
  ];
}

const kubernetesRules: RefRule[] = [
  ...POD_SPECS.flatMap(([kind, p]) => podSpecRules(kind, p)),
  // A namespaced object is in its Namespace. Optional: most namespaces are made elsewhere.
  ...NAMESPACED_KINDS.flatMap((kind) => rule(kind, "metadata.namespace", NAMESPACE, "in namespace", "containment").map((r) => ({ ...r, optional: true }))),
];

// ── identities, scopes, and the kinds that reference nothing ──

/** What else names a kind, beyond `outputs.id`, `outputs.arn`, `outputs.name` and `name`. */
const EXTRA_IDS: Readonly<Record<string, readonly string[]>> = {
  [S3_BUCKET]: ["bucket", "outputs.bucket"],
  [S3_BUCKET_V2]: ["bucket", "outputs.bucket"],
  [SQS_QUEUE]: ["outputs.url"],
  [IAM_POLICY]: [],
  [ROUTE53_ZONE]: ["outputs.zoneId"],
  [LB]: ["outputs.dnsName"],
  [GCP_NETWORK]: ["outputs.selfLink"],
  [GCP_SUBNETWORK]: ["outputs.selfLink"],
  [GCP_SERVICE_ACCOUNT]: ["accountId", "outputs.email"],
  [GCP_SECRET]: ["secretId"],
  [GCP_CLUSTER]: ["outputs.selfLink"],
  [AZURE_NATIVE.group]: ["resourceGroupName"],
  [AZURE_NATIVE.vnet]: ["virtualNetworkName"],
  [AZURE_NATIVE.subnet]: ["subnetName"],
};

const AWS_NAMED = [
  VPC, SUBNET, SECURITY_GROUP, ROUTE_TABLE, INTERNET_GATEWAY, NAT_GATEWAY, EIP, INSTANCE, NETWORK_INTERFACE, LB, TARGET_GROUP, ECS_CLUSTER, ECS_TASK,
  IAM_ROLE, IAM_POLICY, INSTANCE_PROFILE, LAMBDA, S3_BUCKET, S3_BUCKET_V2, ROUTE53_ZONE, EKS_CLUSTER, RDS_SUBNET_GROUP, RDS_CLUSTER, SQS_QUEUE, SNS_TOPIC, KMS_KEY, LOG_GROUP,
  "aws:secretsmanager/secret:Secret", "aws:elasticache/subnetGroup:SubnetGroup", "aws:rds/instance:Instance",
];
const GCP_NAMED = [GCP_NETWORK, GCP_SUBNETWORK, GCP_INSTANCE, GCP_CLUSTER, GCP_SERVICE_ACCOUNT, GCP_SECRET, GCP_BUCKET];
const AZURE_NAMED = AZURE_FAMILIES.flatMap((f) => [f.group, f.vnet, f.subnet, f.aks, f.nsg]);

/** Kinds whose identities are `metadata.name`, in place of the provider outputs. */
const K8S_NAMED = new Set(NAMED_KINDS);

const identities: IdentityRule[] = [
  ...[...AWS_NAMED, ...GCP_NAMED, ...AZURE_NAMED].map((kind) => ({ kind, ids: ["outputs.id", "outputs.arn", "outputs.name", "name", ...(EXTRA_IDS[kind] ?? [])] })),
  ...[...K8S_NAMED].map((kind) => ({ kind, ids: ["metadata.name"] })),
];

const scopes: ScopeRule[] = NAMESPACED_KINDS.map((kind) => ({ kind, path: "metadata.namespace" }));

/**
 * Pulumi kinds this catalog has looked at and found to hold no input that
 * identifies another resource. A node of one of these kinds is not an
 * unresolved kind: nothing was looked for because there is nothing to find.
 */
export const REFERENCES_NOTHING: ReadonlySet<string> = new Set([
  VPC,
  EIP,
  S3_BUCKET,
  S3_BUCKET_V2,
  ECS_CLUSTER,
  ROUTE53_ZONE,
  KMS_KEY,
  SQS_QUEUE,
  SNS_TOPIC,
  GCP_NETWORK,
  GCP_SECRET,
  GCP_BUCKET,
  GCP_SERVICE_ACCOUNT,
  AZURE_NATIVE.group,
  AZURE_CLASSIC.group,
  NAMESPACE,
  CONFIG_MAP,
  SECRET,
  SERVICE_ACCOUNT,
]);

/** The catalog. Rules are grouped by provider; each provider lists containment before references. */
export const PULUMI_REFERENCE_CATALOG: ReferenceCatalog = {
  identities,
  scopes,
  refs: [...awsRules, ...gcpRules, ...azureRules, ...kubernetesRules],
};

/** Every Pulumi kind the catalog has at least one rule from. */
export const CATALOGUED_KINDS: ReadonlySet<string> = new Set(PULUMI_REFERENCE_CATALOG.refs.map((r) => r.from));

/**
 * True when nothing would be looked for on a node of this kind: no rule is
 * written for it, and it is not one of the kinds known to reference nothing.
 */
export function isUnresolvedKind(kind: string): boolean {
  return !CATALOGUED_KINDS.has(kind) && !REFERENCES_NOTHING.has(kind);
}
