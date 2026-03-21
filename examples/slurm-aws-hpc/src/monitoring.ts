import { Alarm } from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { scratchFs } from "./storage";
import { dbCluster } from "./database";
import { gpuAsg } from "./compute";
import { config } from "./config";

// ── FSx Lustre throughput alarm ───────────────────────────────────
// Alert when sustained read throughput approaches provisioned limit.
// At 1200 GiB × 200 MB/s/TiB = 240 GB/s provisioned; alarm at 80% = 192 GB/s.
// (Note: EFS would use BurstCreditBalance alarm — FSx Lustre has no burst model)

export const fsxThroughputAlarm = new Alarm({
  AlarmName: Sub(`${config.clusterName}-fsx-throughput-high`),
  AlarmDescription: "FSx Lustre read throughput exceeds 80% of provisioned capacity",
  Namespace: "AWS/FSx",
  MetricName: "DataReadBytes",
  Dimensions: [{ Name: "FileSystemId", Value: scratchFs.Id }],
  Period: 300,
  EvaluationPeriods: 3,
  Statistic: "Sum",
  // 192 GB/s × 300s = 57.6 TB per 5-min window
  Threshold: 57_600_000_000_000,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
});

// ── Aurora (slurmdbd) CPU alarm ───────────────────────────────────
// slurmdbd should be mostly idle. CPU > 80% means job submission storm or
// misconfigured sacct queries hammering the DB.

export const rdsAlarm = new Alarm({
  AlarmName: Sub(`${config.clusterName}-slurmdbd-cpu-high`),
  AlarmDescription: "Aurora MySQL (slurmdbd) CPU utilization above 80%",
  Namespace: "AWS/RDS",
  MetricName: "CPUUtilization",
  Dimensions: [{ Name: "DBClusterIdentifier", Value: dbCluster.DBClusterArn }],
  Period: 60,
  EvaluationPeriods: 5,
  Statistic: "Average",
  Threshold: 80,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
});

// ── Spot interruption rate alarm ──────────────────────────────────
// If spot interruptions > 2 in 5 minutes, the instance type pool is depleted.
// Switch allocation strategy or add more override instance types.

export const spotInterruptionAlarm = new Alarm({
  AlarmName: Sub(`${config.clusterName}-spot-interruptions`),
  AlarmDescription: "High spot interruption rate on GPU fleet — consider adding instance types",
  Namespace: "AWS/AutoScaling",
  MetricName: "WarmPoolTerminatedInstances",
  Dimensions: [{ Name: "AutoScalingGroupName", Value: gpuAsg.AutoScalingGroupARN }],
  Period: 300,
  EvaluationPeriods: 1,
  Statistic: "Sum",
  Threshold: 2,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
});

// ── GPU ASG scale-up lag alarm ────────────────────────────────────
// If desired > in-service for > 15 minutes, ResumeProgram is stuck.
// Common causes: AMI not in region, launch template IAM role misconfigured.

export const asgLagAlarm = new Alarm({
  AlarmName: Sub(`${config.clusterName}-gpu-asg-launch-lag`),
  AlarmDescription: "GPU ASG desired capacity exceeds in-service for >15min — ResumeProgram issue",
  Namespace: "AWS/AutoScaling",
  MetricName: "PendingInstances",
  Dimensions: [{ Name: "AutoScalingGroupName", Value: gpuAsg.AutoScalingGroupARN }],
  Period: 300,
  EvaluationPeriods: 3,
  Statistic: "Maximum",
  Threshold: 0,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
});
