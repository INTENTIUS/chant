/**
 * RBAC verb constants for core API group resources.
 */

/** Standard RBAC verbs applicable to most resources. */
export const StandardVerbs = {
  get: "get",
  list: "list",
  watch: "watch",
  create: "create",
  update: "update",
  patch: "patch",
  delete: "delete",
} as const;

export const PodActions = {
  ...StandardVerbs,
  exec: "create", // pods/exec subresource
  portForward: "create", // pods/portforward subresource
  log: "get", // pods/log subresource
} as const;

export const ServiceActions = {
  ...StandardVerbs,
  proxy: "create",
} as const;

export const ConfigMapActions = { ...StandardVerbs } as const;

export const SecretActions = { ...StandardVerbs } as const;

export const NamespaceActions = { ...StandardVerbs } as const;

export const ServiceAccountActions = {
  ...StandardVerbs,
  impersonate: "impersonate",
} as const;

export const PersistentVolumeActions = { ...StandardVerbs } as const;

export const PersistentVolumeClaimActions = { ...StandardVerbs } as const;

export const NodeActions = {
  get: "get",
  list: "list",
  watch: "watch",
  update: "update",
  patch: "patch",
} as const;

export const EventActions = {
  get: "get",
  list: "list",
  watch: "watch",
  create: "create",
} as const;

export const ResourceQuotaActions = { ...StandardVerbs } as const;

export const LimitRangeActions = { ...StandardVerbs } as const;

export const EndpointsActions = { ...StandardVerbs } as const;
