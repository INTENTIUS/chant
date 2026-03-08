// K8s workloads: FluentBit + ADOT agents for CloudWatch logging and metrics.

import {
  Namespace,
  FluentBitAgent,
  AdotCollector,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

// ── Agent Namespaces ─────────────────────────────────────────────

export const cloudwatchNamespace = new Namespace({
  metadata: { name: "amazon-cloudwatch", labels: { "app.kubernetes.io/managed-by": "chant" } },
});

export const metricsNamespace = new Namespace({
  metadata: { name: "amazon-metrics", labels: { "app.kubernetes.io/managed-by": "chant" } },
});

// ── Fluent Bit ───────────────────────────────────────────────────

const fb = FluentBitAgent({
  clusterName: config.clusterName,
  region: config.region,
  logGroup: `/aws/eks/${config.clusterName}/containers`,
  iamRoleArn: config.fluentBitRoleArn,
});

export const fbDaemonSet = fb.daemonSet;
export const fbClusterRole = fb.clusterRole;
export const fbClusterRoleBinding = fb.clusterRoleBinding;
export const fbConfig = fb.configMap;
export const fbServiceAccount = fb.serviceAccount;

// ── ADOT Collector ───────────────────────────────────────────────

const adot = AdotCollector({
  clusterName: config.clusterName,
  region: config.region,
  iamRoleArn: config.adotRoleArn,
});

export const adotDaemonSet = adot.daemonSet;
export const adotClusterRole = adot.clusterRole;
export const adotClusterRoleBinding = adot.clusterRoleBinding;
export const adotConfig = adot.configMap;
export const adotServiceAccount = adot.serviceAccount;
