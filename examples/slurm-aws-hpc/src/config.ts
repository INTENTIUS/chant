/**
 * Shared configuration for the Slurm EDA HPC cluster.
 *
 * Architecture:
 *   - Head node: c5.2xlarge, runs slurmctld + slurmdbd (connected to Aurora MySQL)
 *   - Compute: c5.9xlarge CPU nodes (synthesis + simulation partitions)
 *   - GPU compute: p4d.24xlarge with EFA + A100×8 (gpu_eda partition)
 *   - Storage: FSx for Lustre PERSISTENT_2 (200 MB/s/TiB) mounted at /scratch
 *   - DB: Aurora MySQL Serverless v2 for slurmdbd accounting
 *   - Networking: VPC with private subnets + EFA cluster placement group
 */

export const config = {
  // Cluster identity
  clusterName: "eda-hpc",
  region: "us-east-1",

  // VPC (pre-existing or created elsewhere)
  vpcCidr: "10.0.0.0/16",
  privateSubnet1Cidr: "10.0.1.0/24",
  privateSubnet2Cidr: "10.0.2.0/24",
  privateSubnet3Cidr: "10.0.3.0/24",

  // EC2 sizing
  headNodeInstanceType: "c5.2xlarge",
  cpuInstanceType: "c5.9xlarge",       // 36 vCPUs, 72 GB RAM — synthesis + sim
  gpuInstanceTypes: ["p4d.24xlarge", "p3.16xlarge"], // spot fleet overrides

  // EDA license counts
  licenses: {
    eda_synth: 50,
    eda_sim: 200,
    calibre_drc: 30,
  },

  // FSx Lustre
  fsxStorageCapacityGiB: 1200,
  fsxThroughputPerTiBMBps: 200,

  // Spot fleet
  spotAllocationStrategy: "capacity-optimized" as const,
  onDemandBaseCapacity: 0,
  spotInstancePercentage: 80,

  // Slurm accounting
  accountingStorageType: "accounting_storage/slurmdbd",
} as const;
