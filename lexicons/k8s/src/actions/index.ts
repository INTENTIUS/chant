/**
 * Kubernetes RBAC verb constants — organized by API group.
 */

// Core
export {
  StandardVerbs,
  PodActions,
  ServiceActions,
  ConfigMapActions,
  SecretActions,
  NamespaceActions,
  ServiceAccountActions,
  PersistentVolumeActions,
  PersistentVolumeClaimActions,
  NodeActions,
  EventActions,
  ResourceQuotaActions,
  LimitRangeActions,
  EndpointsActions,
} from "./core";

// Apps
export {
  DeploymentActions,
  StatefulSetActions,
  DaemonSetActions,
  ReplicaSetActions,
} from "./apps";

// RBAC
export {
  RoleActions,
  ClusterRoleActions,
  RoleBindingActions,
  ClusterRoleBindingActions,
} from "./rbac";

// Batch
export {
  JobActions,
  CronJobActions,
} from "./batch";

// Networking
export {
  IngressActions,
  IngressClassActions,
  NetworkPolicyActions,
} from "./networking";
