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
import { Sub } from "@intentius/chant-lexicon-aws";
import { privateSubnet1 } from "./networking";
import { clusterSg } from "./security";
import { efaPlacementGroup } from "./networking";
import { computeInstanceProfile } from "./iam";
import { scratchFs } from "./storage";
import { config } from "./config";

// User data installs Slurm compute daemon and mounts FSx
const COMPUTE_USERDATA = Sub([
  "#!/bin/bash",
  "set -euo pipefail",
  "",
  "# Mount FSx Lustre",
  `mkdir -p /scratch`,
  `amazon-linux-extras install -y lustre`,
  `mount -t lustre -o relatime,flock \${${scratchFs.DNSName}}@tcp:/${scratchFs.LustreMountName} /scratch`,
  "",
  "# Start slurmd",
  "systemctl enable --now slurmd",
].join("\\n"));

export const gpuLaunchTemplate = new LaunchTemplate({
  LaunchTemplateName: Sub(`${config.clusterName}-gpu-lt`),
  LaunchTemplateData: {
    ImageId: "{{resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id}}",
    IamInstanceProfile: { Arn: computeInstanceProfile.Arn },
    SecurityGroupIds: [clusterSg.GroupId],
    UserData: COMPUTE_USERDATA,
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
export const spotTerminationHook = new LifecycleHook({
  AutoScalingGroupName: gpuAsg.AutoScalingGroupARN,
  LifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
  HeartbeatTimeout: 300,   // 5 minutes — Slurm spot interruption warning is 2 min
  DefaultResult: "CONTINUE",
});
