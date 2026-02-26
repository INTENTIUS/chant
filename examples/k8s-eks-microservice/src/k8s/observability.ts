// K8s workloads: FluentBit + ADOT agents for CloudWatch logging and metrics.

import {
  DaemonSet,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
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

export const fbDaemonSet = new DaemonSet(fb.daemonSet);
export const fbClusterRole = new ClusterRole(fb.clusterRole);
export const fbClusterRoleBinding = new ClusterRoleBinding(fb.clusterRoleBinding);
export const fbConfig = new ConfigMap(fb.configMap);
export const fbServiceAccount = new ServiceAccount(fb.serviceAccount);

// ── ADOT Collector ───────────────────────────────────────────────

const adot = AdotCollector({
  clusterName: config.clusterName,
  region: config.region,
  iamRoleArn: config.adotRoleArn,
});

export const adotDaemonSet = new DaemonSet(adot.daemonSet);
export const adotClusterRole = new ClusterRole(adot.clusterRole);
export const adotClusterRoleBinding = new ClusterRoleBinding(adot.clusterRoleBinding);
export const adotConfig = new ConfigMap(adot.configMap);
export const adotServiceAccount = new ServiceAccount(adot.serviceAccount);
