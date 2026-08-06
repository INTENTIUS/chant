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
   * versions omitted take EKS's default. Up to three (fixed member slots
   * `addon1..addon3`, keyed by position — the statically-evaluable shape);
   * an estate needing more declares the rest as bare Addon resources.
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

  // Three fixed add-on slots, the same statically-evaluable shape
  // vpc-default uses for its optional third AZ: a ternary is an expression
  // (EVL-clean); a loop-built member map is control flow the reference
  // composites must not contain (EVL002/EVL003). Members are addon1..addon3
  // in the caller's order — logical ids stay stable as long as the order
  // does, which the caller controls.
  const a1 = props.addons?.[0];
  const a2 = props.addons?.[1];
  const a3 = props.addons?.[2];
  const addon1 = a1
    ? new Addon({ ClusterName: props.name, AddonName: a1.name, AddonVersion: a1.version, Tags: props.tags }, { DependsOn: [cluster] })
    : undefined;
  const addon2 = a2
    ? new Addon({ ClusterName: props.name, AddonName: a2.name, AddonVersion: a2.version, Tags: props.tags }, { DependsOn: [cluster] })
    : undefined;
  const addon3 = a3
    ? new Addon({ ClusterName: props.name, AddonName: a3.name, AddonVersion: a3.version, Tags: props.tags }, { DependsOn: [cluster] })
    : undefined;

  if (!props.nodegroup) {
    return {
      clusterRole,
      cluster,
      ...(addon1 ? { addon1 } : {}),
      ...(addon2 ? { addon2 } : {}),
      ...(addon3 ? { addon3 } : {}),
    };
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

  return {
    clusterRole,
    cluster,
    nodeRole,
    nodegroup,
    ...(addon1 ? { addon1 } : {}),
    ...(addon2 ? { addon2 } : {}),
    ...(addon3 ? { addon3 } : {}),
  };
}, "EksCluster");
