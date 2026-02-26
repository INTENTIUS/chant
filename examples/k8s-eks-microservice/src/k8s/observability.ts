// K8s workloads: FluentBit agent for CloudWatch logging.

import {
  DaemonSet,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
  FluentBitAgent,
} from "@intentius/chant-lexicon-k8s";
import { config } from "../config";

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
