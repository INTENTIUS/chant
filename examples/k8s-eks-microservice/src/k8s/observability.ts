// K8s workloads: FluentBit agent for CloudWatch logging.
//
// The FluentBitAgent composite creates the DaemonSet, RBAC, and ConfigMap.
// We add the IRSA annotation to the ServiceAccount manually since the
// composite focuses on K8s config, not AWS identity.

import {
  DaemonSet,
  ServiceAccount,
  ClusterRole,
  ClusterRoleBinding,
  ConfigMap,
  FluentBitAgent,
} from "@intentius/chant-lexicon-k8s";

const fb = FluentBitAgent({
  clusterName: "eks-microservice",
  region: "us-east-1",
  logGroup: "/aws/eks/eks-microservice/containers",
});

export const fbDaemonSet = new DaemonSet(fb.daemonSet);
export const fbClusterRole = new ClusterRole(fb.clusterRole);
export const fbClusterRoleBinding = new ClusterRoleBinding(fb.clusterRoleBinding);
export const fbConfig = new ConfigMap(fb.configMap);

// Add IRSA annotation to the ServiceAccount for CloudWatch access
const saProps = fb.serviceAccount as { metadata: { annotations?: Record<string, string>; [k: string]: unknown }; [k: string]: unknown };
saProps.metadata.annotations = {
  ...saProps.metadata.annotations,
  "eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/eks-microservice-fluent-bit-role",
};
export const fbServiceAccount = new ServiceAccount(fb.serviceAccount);
