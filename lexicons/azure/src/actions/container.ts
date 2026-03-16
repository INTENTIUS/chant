/**
 * Azure Container RBAC built-in role constants (AKS + ACR).
 */
export const ContainerRoles = {
  AksClusterAdmin: "Azure Kubernetes Service Cluster Admin Role",
  AksClusterUser: "Azure Kubernetes Service Cluster User Role",
  AksContributor: "Azure Kubernetes Service Contributor Role",
  AksRbacAdmin: "Azure Kubernetes Service RBAC Admin",
  AksRbacReader: "Azure Kubernetes Service RBAC Reader",
  AcrPull: "AcrPull",
  AcrPush: "AcrPush",
  AcrDelete: "AcrDelete",
  AcrImageSigner: "AcrImageSigner",
} as const;
