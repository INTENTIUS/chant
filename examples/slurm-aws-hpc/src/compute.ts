/**
 * Compute fleet: EFA-enabled spot instances with cluster placement group.
 *
 * Why ec2 run-instances instead of ASG:
 *   - Slurm CLOUD nodes need a specific name (e.g., cpu003) embedded at launch time.
 *   - ASG launches interchangeable instances with no per-node identity.
 *   - ResumeProgram uses run-instances so it can set slurm-node=<name> tag and
 *     MetadataOptions.InstanceMetadataTags=enabled so the compute UserData can
 *     read the tag to self-assign the correct hostname.
 *   - SuspendProgram finds the instance by slurm-node tag and terminates it.
 *
 * GPU nodes use spot instances (--instance-market-options MarketType=spot).
 * For multi-instance-type fallback (p4d → p3), use SpotFleet in production.
 */

import { LaunchTemplate, SsmParameter } from "@intentius/chant-lexicon-aws";
import { Sub, Join, Base64, Ref } from "@intentius/chant-lexicon-aws";
import { privateSubnet1, efaPlacementGroup } from "./networking";
import { clusterSg } from "./security";
import { computeInstanceProfile } from "./iam";
import { scratchFs } from "./storage";
import { config } from "./config";

// ── Shared bootstrap: munge key, slurm.conf, FSx mount ────────────
// Used by both CPU and GPU compute UserData.
// Reads CLUSTER_NAME and REGION from environment (set at top of each UserData).

const SHARED_BOOTSTRAP = [
  "# ── 3. Fetch munge key from SSM ────────────────────────────────────",
  "MUNGE_KEY=$(aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/munge/key \\",
  "  --with-decryption \\",
  "  --region $REGION \\",
  "  --query Parameter.Value --output text)",
  "echo \"$MUNGE_KEY\" | base64 -d > /etc/munge/munge.key",
  "chown munge:munge /etc/munge/munge.key",
  "chmod 400 /etc/munge/munge.key",
  "",
  "# ── 4. Fetch Slurm configuration from SSM ──────────────────────────",
  "# deploy.sh writes slurm.conf, topology.conf, cgroup.conf to SSM after build.",
  "mkdir -p /etc/slurm",
  "aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/slurm/conf \\",
  "  --region $REGION \\",
  "  --query Parameter.Value --output text > /etc/slurm/slurm.conf",
  "aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/slurm/topology-conf \\",
  "  --region $REGION \\",
  "  --query Parameter.Value --output text > /etc/slurm/topology.conf 2>/dev/null || true",
  "aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/slurm/cgroup-conf \\",
  "  --region $REGION \\",
  "  --query Parameter.Value --output text > /etc/slurm/cgroup.conf 2>/dev/null || true",
  "# Resolve head01 → private IP so slurmctld is reachable",
  "HEAD_IP=$(aws ssm get-parameter \\",
  "  --name /$CLUSTER_NAME/head-node/private-ip \\",
  "  --region $REGION \\",
  "  --query Parameter.Value --output text)",
  "echo \"$HEAD_IP head01\" >> /etc/hosts",
  "",
  "# ── 5. Mount FSx Lustre (persistent via fstab) ─────────────────────",
  "mkdir -p /scratch",
  Sub`mount -t lustre -o relatime,flock ${scratchFs.DNSName}@tcp:/${scratchFs.LustreMountName} /scratch || {`,
  "  echo \"ERROR: FSx Lustre mount failed — verify SG allows ports 988/1018-1023\" >&2",
  "  exit 1",
  "}",
  Sub`echo '${scratchFs.DNSName}@tcp:/${scratchFs.LustreMountName} /scratch lustre relatime,flock,_netdev 0 0' >> /etc/fstab`,
  "",
  "# ── 6. Create Slurm spool directory ───────────────────────────────",
  "mkdir -p /var/spool/slurmd",
  "chown slurm:slurm /var/spool/slurmd",
];

// ── CPU compute: Amazon Linux 2, no GPU gres.conf ────────────────
// UserData reads the slurm-node EC2 tag (set by ResumeProgram) to self-assign
// its Slurm node name and registers NodeAddr with slurmctld after slurmd starts.

const CPU_COMPUTE_USERDATA = Base64(Join("\n", [
  "#!/bin/bash",
  "set -euo pipefail",
  "exec > >(tee /var/log/slurm-compute-bootstrap.log) 2>&1",
  "",
  Sub`CLUSTER_NAME=\${AWS::StackName}`,
  `REGION=${config.region}`,
  "",
  "# ── 1. Discover Slurm node name from EC2 instance tag ─────────────",
  "# ResumeProgram sets slurm-node=<name> tag at launch with InstanceMetadataTags enabled.",
  "TOKEN=$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' \\",
  "  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
  "SLURM_NODE=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" \\",
  "  http://169.254.169.254/latest/meta-data/tags/instance/slurm-node)",
  "if [[ -z \"$SLURM_NODE\" ]]; then",
  "  echo 'ERROR: slurm-node tag not found in instance metadata' >&2",
  "  exit 1",
  "fi",
  "hostnamectl set-hostname \"$SLURM_NODE\"",
  "PRIVATE_IP=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" \\",
  "  http://169.254.169.254/latest/meta-data/local-ipv4)",
  "",
  "# ── 2. Install Slurm compute daemon and munge ─────────────────────",
  "amazon-linux-extras install -y epel lustre",
  "yum install -y munge munge-libs",
  "yum install -y slurm slurm-slurmd 2>/dev/null || \\",
  "  yum install -y --enablerepo=epel slurm slurm-slurmd",
  "id slurm &>/dev/null || useradd -r -s /bin/false -d /var/lib/slurm slurm",
  "",
  ...SHARED_BOOTSTRAP,
  "",
  "# ── 7. Start munge and slurmd ─────────────────────────────────────",
  "systemctl enable --now munge",
  "systemctl enable --now slurmd",
  "",
  "# ── 8. Register NodeAddr with slurmctld ────────────────────────────",
  "# slurmctld resolves NodeAddr=cpu001 via DNS, but EC2 private hostnames",
  "# aren't registered in VPC DNS. Update NodeAddr to the actual private IP",
  "# so slurmctld can ping slurmd for health monitoring.",
  "for i in $(seq 1 12); do",
  "  scontrol update NodeName=\"$SLURM_NODE\" NodeAddr=\"$PRIVATE_IP\" 2>/dev/null && break",
  "  echo \"Waiting for slurmd to register (attempt $i/12)...\"",
  "  sleep 5",
  "done",
]));

// ── GPU compute: ECS GPU-optimized AMI, gres.conf for NVML ──────
// Identical structure to CPU but with gres.conf for A100 NVML detection.

const GPU_COMPUTE_USERDATA = Base64(Join("\n", [
  "#!/bin/bash",
  "set -euo pipefail",
  "exec > >(tee /var/log/slurm-compute-bootstrap.log) 2>&1",
  "",
  Sub`CLUSTER_NAME=\${AWS::StackName}`,
  `REGION=${config.region}`,
  "",
  "# ── 1. Discover Slurm node name from EC2 instance tag ─────────────",
  "TOKEN=$(curl -s -X PUT 'http://169.254.169.254/latest/api/token' \\",
  "  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
  "SLURM_NODE=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" \\",
  "  http://169.254.169.254/latest/meta-data/tags/instance/slurm-node)",
  "if [[ -z \"$SLURM_NODE\" ]]; then",
  "  echo 'ERROR: slurm-node tag not found in instance metadata' >&2",
  "  exit 1",
  "fi",
  "hostnamectl set-hostname \"$SLURM_NODE\"",
  "PRIVATE_IP=$(curl -s -H \"X-aws-ec2-metadata-token: $TOKEN\" \\",
  "  http://169.254.169.254/latest/meta-data/local-ipv4)",
  "",
  "# ── 2. Install Slurm compute daemon and munge ─────────────────────",
  "# ECS GPU AMI has CUDA + NVIDIA drivers pre-installed.",
  "amazon-linux-extras install -y epel",
  "yum install -y munge munge-libs",
  "yum install -y slurm slurm-slurmd 2>/dev/null || \\",
  "  yum install -y --enablerepo=epel slurm slurm-slurmd",
  "id slurm &>/dev/null || useradd -r -s /bin/false -d /var/lib/slurm slurm",
  "",
  ...SHARED_BOOTSTRAP,
  "",
  "# ── GPU resource detection (required for GRES accounting) ──────────",
  "cat > /etc/slurm/gres.conf << 'EOF'",
  "AutoDetect=nvml",
  "EOF",
  "",
  "# ── 7. Start munge and slurmd ─────────────────────────────────────",
  "systemctl enable --now munge",
  "systemctl enable --now slurmd",
  "",
  "# ── 8. Register NodeAddr with slurmctld ────────────────────────────",
  "for i in $(seq 1 12); do",
  "  scontrol update NodeName=\"$SLURM_NODE\" NodeAddr=\"$PRIVATE_IP\" 2>/dev/null && break",
  "  echo \"Waiting for slurmd to register (attempt $i/12)...\"",
  "  sleep 5",
  "done",
]));

// ── CPU launch template ────────────────────────────────────────────
// NetworkInterfaces[0] embeds subnet + SG so ResumeProgram only needs
// --launch-template and --tag-specifications (no subnet/sg flags needed).
// MetadataOptions.InstanceMetadataTags=enabled makes slurm-node tag readable
// from within UserData via the IMDS API.

export const cpuLaunchTemplate = new LaunchTemplate({
  LaunchTemplateName: Sub("\${AWS::StackName}-cpu-lt"),
  LaunchTemplateData: {
    ImageId: "{{resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-x86_64-gp2}}",
    InstanceType: config.cpuInstanceType,
    IamInstanceProfile: { Arn: computeInstanceProfile.Arn },
    MetadataOptions: {
      HttpTokens: "optional",             // IMDSv1 + v2 both allowed
      InstanceMetadataTags: "enabled",    // slurm-node tag readable via metadata
    },
    NetworkInterfaces: [
      {
        DeviceIndex: 0,
        SubnetId: privateSubnet1.SubnetId,
        Groups: [clusterSg.GroupId],
        DeleteOnTermination: true,
      },
    ],
    UserData: CPU_COMPUTE_USERDATA,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "cluster", Value: Sub("\${AWS::StackName}") },
          { Key: "role", Value: "compute-cpu" },
        ],
      },
    ],
  },
});

// ── GPU launch template ────────────────────────────────────────────
// EFA network interface requires InterfaceType=efa and a placement group.
// The placement group name is stored in SSM for use by the GPU ResumeProgram.

export const gpuLaunchTemplate = new LaunchTemplate({
  LaunchTemplateName: Sub("\${AWS::StackName}-gpu-lt"),
  LaunchTemplateData: {
    ImageId: "{{resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2/gpu/recommended/image_id}}",
    InstanceType: config.gpuInstanceTypes[0],   // primary type; fallback set in ResumeProgram
    IamInstanceProfile: { Arn: computeInstanceProfile.Arn },
    MetadataOptions: {
      HttpTokens: "optional",
      InstanceMetadataTags: "enabled",
    },
    // EFA network interface — required for p4d.24xlarge full 400 Gbps bandwidth
    NetworkInterfaces: [
      {
        InterfaceType: "efa",
        DeviceIndex: 0,
        Groups: [clusterSg.GroupId],
        SubnetId: privateSubnet1.SubnetId,
        DeleteOnTermination: true,
      },
    ],
    UserData: GPU_COMPUTE_USERDATA,
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "cluster", Value: Sub("\${AWS::StackName}") },
          { Key: "role", Value: "compute-gpu" },
        ],
      },
    ],
  },
});

// ── SSM parameters for launch template IDs ─────────────────────────
// ResumeProgram reads these to launch instances via ec2 run-instances.
// Stored as SSM parameters so the bash scripts on the head node can
// resolve them without baking CFN resource IDs into the scripts.

export const cpuLtIdParam = new SsmParameter({
  Name: Sub("/\${AWS::StackName}/compute/cpu/launch-template-id"),
  Type: "String",
  Value: cpuLaunchTemplate.LaunchTemplateId,
  Description: Sub("CPU compute launch template ID for \${AWS::StackName}"),
});

export const gpuLtIdParam = new SsmParameter({
  Name: Sub("/\${AWS::StackName}/compute/gpu/launch-template-id"),
  Type: "String",
  Value: gpuLaunchTemplate.LaunchTemplateId,
  Description: Sub("GPU compute launch template ID for \${AWS::StackName}"),
});

export const gpuPlacementGroupParam = new SsmParameter({
  Name: Sub("/\${AWS::StackName}/compute/gpu/placement-group"),
  Type: "String",
  Value: Ref(efaPlacementGroup),
  Description: Sub("EFA placement group name for GPU nodes in \${AWS::StackName}"),
});
