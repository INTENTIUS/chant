/**
 * EksCluster — a managed EKS control plane, its node group, and the two IAM
 * roles they cannot exist without, as the one unit they are.
 *
 * The first consumer is kubemicrovm-ops' cluster plane (its "all infra from
 * the tiers and targets" directive: the cluster stops being a
 * reference-existing input and becomes provisionable), but nothing here is
 * kubemicrovm-shaped — a cluster+nodegroup+roles bundle is what every EKS
 * estate starts with, and cc-aws-canonical's bare cluster is the degenerate
 * form of it.
 *
 * What is deliberately NOT here:
 *  - Networking. EKS requires subnets in at least two AZs, and `VpcDefault`
 *    (this directory) already provisions exactly that shape — the two
 *    composites compose rather than nest, so an adopter with their own VPC
 *    passes their own subnet ids.
 *  - Add-ons, OIDC/IRSA, access entries. Real per-estate decisions; a bundle
 *    that guessed them would fight every adopter. `defaults.cluster` /
 *    `defaults.nodegroup` are the escape hatch for the fields this surface
 *    does not name.
 *
 * On floci the cluster is k3s-backed and real (`aws eks update-kubeconfig`
 * works, pods run — the cc-aws-canonical estate proved the path); the node
 * group is accepted and tracked but backs no separate machines, which is the
 * emulator being honest about what a laptop can host.
 */
import { Composite, mergeDefaults } from "@intentius/chant";
import { Addon, EKSCluster, Nodegroup, Role } from "../generated";
import { Sub } from "../intrinsics";

export interface EksClusterProps {
  /** Cluster name. Required: everything downstream addresses the cluster by it. */
  name: string;
  /** Subnet ids for the control plane ENIs — EKS requires at least two AZs. */
  subnetIds: string[];
  /** Extra security groups for the control plane (EKS always adds its own). */
  securityGroupIds?: string[];
  /** Kubernetes version, e.g. "1.31". Omitted takes EKS's current default. */
  version?: string;
  /** Node group shape. Omitted provisions no node group (control plane only). */
  nodegroup?: {
    instanceTypes?: string[];
    desiredSize?: number;
    minSize?: number;
    maxSize?: number;
    /** Subnets the nodes land in. Default: the cluster's own `subnetIds`. */
    subnetIds?: string[];
  };
  /**
   * Managed add-ons to install, by name (e.g. "eks-pod-identity-agent" —
   * without which an AWS::EKS::PodIdentityAssociation delivers no
   * credentials and the workload it binds crashloops on startup, found on
   * kubemicrovm-ops' first real deploy). Named by the caller, never guessed;
   * versions omitted take EKS's default for the cluster version.
   */
  addons?: Array<{ name: string; version?: string }>;
  tags?: Array<{ Key: string; Value: string }>;
  defaults?: {
    cluster?: Partial<ConstructorParameters<typeof EKSCluster>[0]>;
    nodegroup?: Partial<ConstructorParameters<typeof Nodegroup>[0]>;
    clusterRole?: Partial<ConstructorParameters<typeof Role>[0]>;
    nodeRole?: Partial<ConstructorParameters<typeof Role>[0]>;
  };
}

const managedPolicy = (name: string) => Sub`arn:\${AWS::Partition}:iam::aws:policy/${name}`;

export const EksCluster = Composite((props: EksClusterProps) => {
  const { defaults } = props;

  const clusterRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { Service: "eks.amazonaws.com" }, Action: "sts:AssumeRole" },
      ],
    },
    ManagedPolicyArns: [managedPolicy("AmazonEKSClusterPolicy")],
    Tags: props.tags,
  }, defaults?.clusterRole));

  const cluster = new EKSCluster(mergeDefaults({
    Name: props.name,
    RoleArn: clusterRole.Arn,
    Version: props.version,
    ResourcesVpcConfig: {
      SubnetIds: props.subnetIds,
      ...(props.securityGroupIds ? { SecurityGroupIds: props.securityGroupIds } : {}),
    },
    Tags: props.tags,
  }, defaults?.cluster));

  // One member per add-on, keyed from its name ("eks-pod-identity-agent" →
  // addonEksPodIdentityAgent) — composite members are a keyed record, and a
  // deterministic key is what keeps the logical id stable across deploys.
  const addonMembers: Record<string, InstanceType<typeof Addon>> = {};
  for (const a of props.addons ?? []) {
    const key = "addon" + a.name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
    addonMembers[key] = new Addon(
      {
        ClusterName: props.name,
        AddonName: a.name,
        AddonVersion: a.version,
        Tags: props.tags,
      },
      { DependsOn: [cluster] },
    );
  }

  if (!props.nodegroup) {
    return { clusterRole, cluster, ...addonMembers };
  }

  const nodeRole = new Role(mergeDefaults({
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" },
      ],
    },
    ManagedPolicyArns: [
      managedPolicy("AmazonEKSWorkerNodePolicy"),
      managedPolicy("AmazonEKS_CNI_Policy"),
      managedPolicy("AmazonEC2ContainerRegistryReadOnly"),
    ],
    Tags: props.tags,
  }, defaults?.nodeRole));

  const nodegroup = new Nodegroup(mergeDefaults({
    // The literal, not an attribute reference: Name is an input the caller
    // gave us, and the generated class exposes accessors only for GetAtt
    // attributes. The creation-order edge is DependsOn below.
    ClusterName: props.name,
    NodeRole: nodeRole.Arn,
    Subnets: props.nodegroup.subnetIds ?? props.subnetIds,
    InstanceTypes: props.nodegroup.instanceTypes ?? ["t3.medium"],
    ScalingConfig: {
      DesiredSize: props.nodegroup.desiredSize ?? 2,
      MinSize: props.nodegroup.minSize ?? props.nodegroup.desiredSize ?? 2,
      MaxSize: props.nodegroup.maxSize ?? props.nodegroup.desiredSize ?? 2,
    },
    Tags: props.tags ? Object.fromEntries(props.tags.map((t) => [t.Key, t.Value])) : undefined,
  }, defaults?.nodegroup), { DependsOn: [cluster] });

  return { clusterRole, cluster, nodeRole, nodegroup, ...addonMembers };
}, "EksCluster");
