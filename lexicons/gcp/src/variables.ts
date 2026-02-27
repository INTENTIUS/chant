/**
 * Well-known Config Connector annotation keys.
 */
export const GcpAnnotations = {
  /** Bind a resource to a specific GCP project. */
  ProjectId: "cnrm.cloud.google.com/project-id",
  /** Control what happens when a resource is deleted from K8s. */
  DeletionPolicy: "cnrm.cloud.google.com/deletion-policy",
  /** Whether to merge observed spec back into the resource. */
  StateIntoSpec: "cnrm.cloud.google.com/state-into-spec",
  /** Strategy when another controller manages the same resource. */
  ManagementConflictPolicy: "cnrm.cloud.google.com/management-conflict-prevention-policy",
  /** Disable dependent resource reconciliation. */
  SkipDependentResources: "cnrm.cloud.google.com/skip-dependent-resources",
} as const;
