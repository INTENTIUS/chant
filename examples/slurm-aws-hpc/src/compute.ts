/**
 * Compute fleet: EFA-enabled spot instances with cluster placement group.
 *
 * Why this topology:
 *   - p4d.24xlarge: 8×A100-80GB, 400Gbps EFA, 96 vCPU — best for multi-node training
 *   - p3.16xlarge: spot overflow when p4d capacity is scarce (same EFA lane widths)
 *   - Cluster placement group: keeps EFA traffic within a single AZ rack
 *   - capacity-optimized: maximizes spot availability for GPU instances
 *   - LifecycleHook: gives Slurm 5 minutes to requeue jobs before the instance disappears
 */

import { LaunchTemplate, AutoScalingGroup, LifecycleHook } from "@intentius/chant-lexicon-aws";
import { Sub, Join, Base64, Ref } from "@intentius/chant-lexicon-aws";
import { privateSubnet1 } from "./networking";
import { clusterSg } from "./security";
import { efaPlacementGroup } from "./networking";
import { computeInstanceProfile } from "./iam";
import { scratchFs } from "./storage";
import { config } from "./config";

// Shared bootstrap snippet: resolves head01 via SSM and writes a minimal slurm.conf
// so slurmd can locate slurmctld for the enable_configless initial fetch.
const SLURMD_BOOTSTRAP = [
  `CLUSTER_NAME=${config.clusterName}`,
  `REGION=${config.region}`,
  "HEAD_IP=$(aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/head-node/private-ip \\",
  "  --region $REGION --query Parameter.Value --output text)",
  "echo \"$HEAD_IP head01\" >> /etc/hosts",
  "mkdir -p /etc/slurm",
  "cat > /etc/slurm/slurm.conf << 'EOF'",
  `ClusterName=${config.clusterName}`,
  "SlurmctldHost=head01",
  "AuthType=auth/munge",
  "EOF",
];

// GPU compute: ECS GPU-optimized AMI, gres.conf for NVML, then slurmd
const GPU_COMPUTE_USERDATA = Base64(Join("\n", [
  "#!/bin/bash",
  "set -euo pipefail",
  "",
  "# Mount FSx Lustre",
  "mkdir -p /scratch",
  "amazon-linux-extras install -y lustre",
  Sub`mount -t lustre -o relatime,flock ${scratchFs.DNSName}@tcp:/${scratchFs.LustreMountName} /scratch || {`,
  '  echo "ERROR: FSx Lustre mount failed — verify security groups allow ports 988/1018-1023 and filesystem is AVAILABLE" >&2',
  "  exit 1",
  "}",
  "",
  "# Resolve head01 and bootstrap minimal slurm.conf for configless startup",
  ...SLURMD_BOOTSTRAP,
  "",
  "# GPU resource detection (required for GRES accounting)",
  "cat > /etc/slurm/gres.conf << 'EOF'",
  "AutoDetect=nvml",
  "EOF",
  "",
  "# Start slurmd",
  "systemctl enable --now slurmd",
]));

// CPU compute: standard Amazon Linux 2 AMI, no GPU gres.conf
const CPU_COMPUTE_USERDATA = Base64(Join("\n", [
  "#!/bin/bash",
  "set -euo pipefail",
  "",
  "# Install Slurm compute daemon",
  "amazon-linux-extras install -y epel",
  "yum install -y slurm slurm-slurmd 2>/dev/null || \\",
  "  yum install -y --enablerepo=epel slurm slurm-slurmd",
  "",
  "# Mount FSx Lustre",
  "mkdir -p /scratch",
  "amazon-linux-extras install -y lustre",
  Sub`mount -t lustre -o relatime,flock ${scratchFs.DNSName}@tcp:/${scratchFs.LustreMountName} /scratch || {`,
  '  echo "ERROR: FSx Lustre mount failed — verify security groups allow ports 988/1018-1023 and filesystem is AVAILABLE" >&2',
  "  exit 1",
  "}",
  "",
  "# Resolve head01 and bootstrap minimal slurm.conf for configless startup",
  ...SLURMD_BOOTSTRAP,
  "",
  "# Start slurmd",
  "systemctl enable --now slurmd",
]));

export const cpuLaunchTemplate = new LaunchTemplate({
  LaunchTemplateName: Sub(`${config.clusterName}-cpu-lt`),
  LaunchTemplateData: {
    ImageId: "{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}",
    InstanceType: config.cpuInstanceType,
    IamInstanceProfile: { Arn: computeInstanceProfile.Arn },
    SecurityGroupIds: [clusterSg.GroupId],
    SubnetId: privateSubnet1.SubnetId,
    UserData: CPU_COMPUTE_USERDATA,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [{ Key: "cluster", Value: config.clusterName }, { Key: "role", Value: "compute-cpu" }],
      },
    ],
  },
});

export const cpuAsg = new AutoScalingGroup({
  AutoScalingGroupName: Sub(`${config.clusterName}-cpu-asg`),
  MinSize: "0",
  MaxSize: "32",         // matches cpu[001-032] in slurm-cluster.ts
  DesiredCapacity: "0",  // Slurm SuspendProgram/ResumeProgram controls capacity
  VPCZoneIdentifier: [privateSubnet1.SubnetId],
  LaunchTemplate: {
    LaunchTemplateId: cpuLaunchTemplate.LaunchTemplateId,
    Version: cpuLaunchTemplate.LatestVersionNumber,
  },
  Tags: [{ Key: "cluster", Value: config.clusterName, PropagateAtLaunch: true }],
});

export const gpuLaunchTemplate = new LaunchTemplate({
  LaunchTemplateName: Sub(`${config.clusterName}-gpu-lt`),
  LaunchTemplateData: {
    ImageId: "{{resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id}}",
    IamInstanceProfile: { Arn: computeInstanceProfile.Arn },
    // SecurityGroupIds must NOT be set when NetworkInterfaces is present — CFN rejects the combination.
    // Security group is specified inside NetworkInterfaces[0].Groups below.
    UserData: GPU_COMPUTE_USERDATA,
    // EFA network interface — required for p4d.24xlarge full bandwidth
    NetworkInterfaces: [
      {
        InterfaceType: "efa",
        DeviceIndex: 0,
        Groups: [clusterSg.GroupId],
        SubnetId: privateSubnet1.SubnetId,
      },
    ],
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [{ Key: "cluster", Value: config.clusterName }, { Key: "role", Value: "compute" }],
      },
    ],
  },
});

export const gpuAsg = new AutoScalingGroup({
  AutoScalingGroupName: Sub(`${config.clusterName}-gpu-asg`),
  MinSize: "0",
  MaxSize: "16",          // 16 × p4d.24xlarge = 128 A100 GPUs
  DesiredCapacity: "0",   // Slurm SuspendProgram/ResumeProgram controls capacity
  PlacementGroup: efaPlacementGroup.GroupName,
  // Mixed instances policy: primary=p4d.24xlarge, fallback=p3.16xlarge
  MixedInstancesPolicy: {
    LaunchTemplate: {
      LaunchTemplateSpecification: {
        LaunchTemplateId: gpuLaunchTemplate.LaunchTemplateId,
        Version: gpuLaunchTemplate.LatestVersionNumber,
      },
      Overrides: config.gpuInstanceTypes.map((InstanceType) => ({ InstanceType })),
    },
    InstancesDistribution: {
      OnDemandBaseCapacity: config.onDemandBaseCapacity,
      OnDemandPercentageAboveBaseCapacity: 100 - config.spotInstancePercentage,
      SpotAllocationStrategy: config.spotAllocationStrategy,
    },
  },
  Tags: [{ Key: "cluster", Value: config.clusterName, PropagateAtLaunch: true }],
});

// Lifecycle hook: delays instance termination by 5 minutes so Slurm can requeue jobs
// The spot-handler Lambda completes this hook after drain + requeue.
// Name must match what spot-handler.ts uses: ${clusterName}-spot-termination-hook
export const spotTerminationHook = new LifecycleHook({
  LifecycleHookName: Sub(`${config.clusterName}-spot-termination-hook`),
  AutoScalingGroupName: Ref(gpuAsg),
  LifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
  HeartbeatTimeout: 300,   // 5 minutes — Slurm spot interruption warning is 2 min
  DefaultResult: "CONTINUE",
});
