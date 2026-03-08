// Cell definitions and shared configuration.
//
// Adding a cell means adding one entry here. All K8s resources, IAM roles,
// and pipeline matrix jobs are derived from this array.

export interface CellConfig {
  name: string;
  replicas: number;
  maxReplicas: number;
  cpuRequest: string;
  memoryRequest: string;
  cpuQuota: string;
  memoryQuota: string;
  host: string;
  minAvailable: number;
  cpuTargetPercent: number;
  iamRoleArn: string;
}

export const cells: CellConfig[] = [
  {
    name: "alpha",
    replicas: 3,
    maxReplicas: 10,
    cpuRequest: "250m",
    memoryRequest: "512Mi",
    cpuQuota: "4",
    memoryQuota: "8Gi",
    host: "alpha.cells.example.com",
    minAvailable: 2,
    cpuTargetPercent: 70,
    iamRoleArn: process.env.CELL_ALPHA_ROLE_ARN ?? "arn:aws:iam::123456789012:role/cells-alpha-role",
  },
  {
    name: "beta",
    replicas: 2,
    maxReplicas: 6,
    cpuRequest: "200m",
    memoryRequest: "256Mi",
    cpuQuota: "2",
    memoryQuota: "4Gi",
    host: "beta.cells.example.com",
    minAvailable: 1,
    cpuTargetPercent: 80,
    iamRoleArn: process.env.CELL_BETA_ROLE_ARN ?? "arn:aws:iam::123456789012:role/cells-beta-role",
  },
];

export const shared = {
  clusterName: "cells-cluster",
  region: process.env.AWS_REGION ?? "us-east-1",
  clusterAutoscalerRoleArn:
    process.env.CLUSTER_AUTOSCALER_ROLE_ARN ??
    "arn:aws:iam::123456789012:role/cells-cluster-autoscaler-role",
  ecrRepoUri:
    process.env.ECR_REPO_URI ??
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/cells-app",
  appImage: process.env.APP_IMAGE ?? "nginxinc/nginx-unprivileged:stable",
};
