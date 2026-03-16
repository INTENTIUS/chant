/**
 * GCP IAM role constants for common patterns.
 */

export const StorageRoles = {
  Admin: "roles/storage.admin",
  ObjectAdmin: "roles/storage.objectAdmin",
  ObjectViewer: "roles/storage.objectViewer",
  ObjectCreator: "roles/storage.objectCreator",
} as const;

export const ComputeRoles = {
  Admin: "roles/compute.admin",
  Viewer: "roles/compute.viewer",
  NetworkAdmin: "roles/compute.networkAdmin",
  InstanceAdmin: "roles/compute.instanceAdmin.v1",
} as const;

export const ContainerRoles = {
  Admin: "roles/container.admin",
  Developer: "roles/container.developer",
  Viewer: "roles/container.viewer",
  ClusterAdmin: "roles/container.clusterAdmin",
} as const;

export const IAMRoles = {
  Admin: "roles/iam.serviceAccountAdmin",
  User: "roles/iam.serviceAccountUser",
  TokenCreator: "roles/iam.serviceAccountTokenCreator",
  WorkloadIdentityUser: "roles/iam.workloadIdentityUser",
} as const;

export const SQLRoles = {
  Admin: "roles/cloudsql.admin",
  Client: "roles/cloudsql.client",
  Editor: "roles/cloudsql.editor",
  Viewer: "roles/cloudsql.viewer",
} as const;

export const RunRoles = {
  Admin: "roles/run.admin",
  Developer: "roles/run.developer",
  Invoker: "roles/run.invoker",
  Viewer: "roles/run.viewer",
} as const;

export const PubSubRoles = {
  Admin: "roles/pubsub.admin",
  Publisher: "roles/pubsub.publisher",
  Subscriber: "roles/pubsub.subscriber",
  Viewer: "roles/pubsub.viewer",
} as const;
