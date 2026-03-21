import { SecurityGroup, SecurityGroup_Ingress } from "@intentius/chant-lexicon-aws";
import { vpc } from "./networking";
import { config } from "./config";

// ── Cluster security group (all Slurm nodes) ──────────────────────

export const clusterSg = new SecurityGroup({
  GroupDescription: `${config.clusterName} cluster nodes — Slurm + MPI + EFA`,
  VpcId: vpc.VpcId,
  SecurityGroupIngress: [
    // Slurm: slurmctld (6817), slurmd (6818), slurmrestd (6820)
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 6817, ToPort: 6820, CidrIp: config.vpcCidr }),
    // MUNGE auth daemon
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 830, ToPort: 830, CidrIp: config.vpcCidr }),
    // MPI (OpenMPI uses ephemeral range via PMIx)
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 1024, ToPort: 65535, CidrIp: config.vpcCidr }),
    // EFA uses its own fabric — all traffic within SG for EFA-enabled instances
    new SecurityGroup_Ingress({ IpProtocol: "-1", SourceSecurityGroupId: { Ref: "clusterSg" } } as any),
  ],
  Tags: [{ Key: "Name", Value: `${config.clusterName}-cluster-sg` }],
});

// ── FSx security group (Lustre port 988) ─────────────────────────

export const fsxSg = new SecurityGroup({
  GroupDescription: `${config.clusterName} FSx Lustre access`,
  VpcId: vpc.VpcId,
  SecurityGroupIngress: [
    // Lustre mount protocol (TCP 988)
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 988, ToPort: 988, SourceSecurityGroupId: clusterSg.GroupId }),
    // Lustre data transfer ports
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 1018, ToPort: 1023, SourceSecurityGroupId: clusterSg.GroupId }),
  ],
  Tags: [{ Key: "Name", Value: `${config.clusterName}-fsx-sg` }],
});

// ── RDS (slurmdbd) security group ─────────────────────────────────
// Only the head node runs slurmdbd — restrict to clusterSg

export const rdsSg = new SecurityGroup({
  GroupDescription: `${config.clusterName} Aurora MySQL (slurmdbd)`,
  VpcId: vpc.VpcId,
  SecurityGroupIngress: [
    new SecurityGroup_Ingress({ IpProtocol: "tcp", FromPort: 3306, ToPort: 3306, SourceSecurityGroupId: clusterSg.GroupId }),
  ],
  Tags: [{ Key: "Name", Value: `${config.clusterName}-rds-sg` }],
});
