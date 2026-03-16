// Azure infrastructure: AKS cluster + ACR + Managed Identities + Role Assignments.
//
// Creates an AKS cluster with system-assigned identity, a container registry,
// user-assigned managed identities for workload identity, and role assignments.

import {
  AksCluster,
  ContainerRegistrySecure,
  Azure,
} from "@intentius/chant-lexicon-azure";
import {
  ManagedIdentity,
  RoleAssignment,
} from "@intentius/chant-lexicon-azure";

// ── AKS Cluster ────────────────────────────────────────────────────

export const { cluster } = AksCluster({
  name: "aks-microservice",
  nodeCount: 3,
  vmSize: "Standard_B2s",
  kubernetesVersion: "1.32",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "production" },
});

// ── Container Registry ─────────────────────────────────────────────

export const { registry } = ContainerRegistrySecure({
  name: "aksmicroserviceacr",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "production" },
});

// ── Managed Identities for Workload Identity ──────────────────────

// App identity
export const appIdentity = new ManagedIdentity({
  name: "aks-microservice-app-id",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { "managed-by": "chant" },
});

// External DNS identity
export const externalDnsIdentity = new ManagedIdentity({
  name: "aks-microservice-dns-id",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { "managed-by": "chant" },
});

// Azure Monitor identity
export const monitorIdentity = new ManagedIdentity({
  name: "aks-microservice-monitor-id",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { "managed-by": "chant" },
});

// ── Role Assignments ───────────────────────────────────────────────

// App identity → ACR Pull
export const appAcrPull = new RoleAssignment({
  name: "[guid(resourceGroup().id, 'aks-microservice-app-acr-pull')]",
  principalId: "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'aks-microservice-app-id')).principalId]",
  roleDefinitionId: "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')]",
  principalType: "ServicePrincipal",
});

// External DNS identity → DNS Zone Contributor
export const dnsContributor = new RoleAssignment({
  name: "[guid(resourceGroup().id, 'aks-microservice-dns-contributor')]",
  principalId: "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'aks-microservice-dns-id')).principalId]",
  roleDefinitionId: "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'befefa01-2a29-4197-83a8-272ff33ce314')]",
  principalType: "ServicePrincipal",
});

// Monitor identity → Monitoring Metrics Publisher
export const monitorMetrics = new RoleAssignment({
  name: "[guid(resourceGroup().id, 'aks-microservice-monitor-metrics')]",
  principalId: "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'aks-microservice-monitor-id')).principalId]",
  roleDefinitionId: "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')]",
  principalType: "ServicePrincipal",
});
