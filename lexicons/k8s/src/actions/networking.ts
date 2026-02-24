/**
 * RBAC verb constants for networking.k8s.io API group resources.
 */

import { StandardVerbs } from "./core";

export const IngressActions = { ...StandardVerbs } as const;

export const IngressClassActions = {
  get: "get",
  list: "list",
  watch: "watch",
} as const;

export const NetworkPolicyActions = { ...StandardVerbs } as const;
