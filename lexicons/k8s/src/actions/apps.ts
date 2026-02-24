/**
 * RBAC verb constants for apps API group resources.
 */

import { StandardVerbs } from "./core";

export const DeploymentActions = {
  ...StandardVerbs,
  rollback: "create", // deployments/rollback subresource
  scale: "update", // deployments/scale subresource
} as const;

export const StatefulSetActions = {
  ...StandardVerbs,
  scale: "update",
} as const;

export const DaemonSetActions = { ...StandardVerbs } as const;

export const ReplicaSetActions = {
  ...StandardVerbs,
  scale: "update",
} as const;
