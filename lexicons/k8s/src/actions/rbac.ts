/**
 * RBAC verb constants for rbac.authorization.k8s.io API group.
 */

import { StandardVerbs } from "./core";

export const RoleActions = { ...StandardVerbs } as const;

export const ClusterRoleActions = { ...StandardVerbs } as const;

export const RoleBindingActions = { ...StandardVerbs } as const;

export const ClusterRoleBindingActions = { ...StandardVerbs } as const;
