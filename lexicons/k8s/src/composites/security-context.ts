/** Container-level security context — covers PSS restricted requirements. */
export interface ContainerSecurityContext {
  runAsNonRoot?: boolean;
  readOnlyRootFilesystem?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  allowPrivilegeEscalation?: boolean;
  capabilities?: { add?: string[]; drop?: string[] };
  seccompProfile?: { type: string; localhostProfile?: string };
}
