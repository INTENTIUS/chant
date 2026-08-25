import { Composite, mergeDefaults } from "@intentius/chant";
import { Instance, InstanceProfile, Role, SecurityGroup, SecurityGroup_Ingress } from "../generated";
import { Base64, Ref } from "../intrinsics";

const EC2_ASSUME_ROLE = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
};

/**
 * One inbound rule for the instance's security group. Exactly one of `cidr`,
 * `cidrIpv6`, or `sourceSecurityGroupId` selects the traffic source — the same
 * constraint CloudFormation enforces on `AWS::EC2::SecurityGroup.Ingress`.
 */
export interface Ec2InstanceBundleIngressRule {
  /** Starting port (or the only port, when `toPort` is omitted). */
  fromPort: number;
  /** Ending port of the range. Defaults to `fromPort` (a single port). */
  toPort?: number;
  /** IP protocol. Default: `"tcp"`. */
  protocol?: string;
  /** IPv4 CIDR source. */
  cidr?: string;
  /** IPv6 CIDR source. */
  cidrIpv6?: string;
  /** Security-group source (allow traffic from another SG rather than a CIDR). */
  sourceSecurityGroupId?: string;
  description?: string;
}

export interface Ec2InstanceBundleProps {
  /** AMI id to launch. */
  imageId: string;
  /** VPC the instance and its security group live in. */
  vpcId: string;
  /** Subnet the instance launches into — fixes its AZ and public/private placement. */
  subnetId: string;
  /** EC2 instance type. Default: `"t3.micro"`. */
  instanceType?: string;
  /** SSH key pair name. Omit for keyless access (e.g. SSM Session Manager only). */
  keyName?: string;
  /** Plain-text user-data script; wrapped in `Fn::Base64` for the instance. */
  userData?: string;
  /** Inbound security-group rules. Default: none (no inbound traffic). */
  ingress?: Ec2InstanceBundleIngressRule[];
  /** IAM managed policy ARNs attached to the instance role. */
  ManagedPolicyArns?: string[];
  /** Inline IAM policies attached to the instance role. */
  Policies?: ConstructorParameters<typeof Role>[0]["Policies"];
  defaults?: {
    role?: Partial<ConstructorParameters<typeof Role>[0]>;
    instanceProfile?: Partial<ConstructorParameters<typeof InstanceProfile>[0]>;
    sg?: Partial<ConstructorParameters<typeof SecurityGroup>[0]>;
    instance?: Partial<ConstructorParameters<typeof Instance>[0]>;
  };
}

// A rule needs exactly one traffic source. Kept as a lookup (not an if/else
// chain that builds the `SecurityGroup_Ingress` inline) so the `new` stays out
// of control flow (EVL002).
function ingressSource(rule: Ec2InstanceBundleIngressRule): Partial<Pick<
  ConstructorParameters<typeof SecurityGroup_Ingress>[0],
  "CidrIp" | "CidrIpv6" | "SourceSecurityGroupId"
>> {
  if (rule.cidr) return { CidrIp: rule.cidr };
  if (rule.cidrIpv6) return { CidrIpv6: rule.cidrIpv6 };
  if (rule.sourceSecurityGroupId) return { SourceSecurityGroupId: rule.sourceSecurityGroupId };
  throw new Error(
    `Ec2InstanceBundle ingress rule for port ${rule.fromPort} needs one of cidr, cidrIpv6, or sourceSecurityGroupId`,
  );
}

/**
 * EC2 instance bundle — instance + security group + role/profile + subnet
 * placement, the hand-rolled unit the aws-bench corpus showed 25 times
 * (`ec2.Instance`) alongside 79 `ec2.SecurityGroup` instantiations (#1139).
 * `Ec2InstanceRole` already covers the role/profile half; this composite adds
 * the instance and its security group, wired to that same role.
 */
export const Ec2InstanceBundle = Composite((props: Ec2InstanceBundleProps) => {
  const { defaults } = props;
  const instanceType = props.instanceType ?? "t3.micro";
  const ingress = props.ingress ?? [];

  const role = new Role(mergeDefaults({
    AssumeRolePolicyDocument: EC2_ASSUME_ROLE,
    ManagedPolicyArns: props.ManagedPolicyArns ?? [],
    Policies: props.Policies ?? [],
  }, defaults?.role));

  const instanceProfile = new InstanceProfile(mergeDefaults({
    Roles: [Ref(role)],
  }, defaults?.instanceProfile));

  // The list-length is dynamic (a caller-supplied array of rules, unlike the
  // fixed one-or-zero-rule shape RdsInstance's ternary handles), so this
  // `.map()` — and the `ingressSource(rule)` spread inside it — has to live
  // in the factory rather than be pre-computed as a const above it. Both are
  // the accepted, already-shipped shape for this in the codebase: EVL004
  // exempts spreads inside the Composite factory precisely for this case,
  // and EVL010's warning on the `.map()` here matches the same warning on
  // FargateAlb, FargateService, and EksCluster's per-item resource lists.
  const ingressRules = ingress.map((rule) => new SecurityGroup_Ingress({
    IpProtocol: rule.protocol ?? "tcp",
    FromPort: rule.fromPort,
    ToPort: rule.toPort ?? rule.fromPort,
    Description: rule.description,
    ...ingressSource(rule),
  }));

  const sg = new SecurityGroup(mergeDefaults({
    GroupDescription: "Security group for EC2 instance",
    VpcId: props.vpcId,
    SecurityGroupIngress: ingressRules.length > 0 ? ingressRules : undefined,
  }, defaults?.sg));

  const instance = new Instance(mergeDefaults({
    ImageId: props.imageId,
    InstanceType: instanceType,
    SubnetId: props.subnetId,
    SecurityGroupIds: [sg.GroupId],
    IamInstanceProfile: Ref(instanceProfile),
    KeyName: props.keyName,
    UserData: props.userData ? Base64(props.userData) : undefined,
  }, defaults?.instance));

  return { role, instanceProfile, sg, instance };
}, "Ec2InstanceBundle");
