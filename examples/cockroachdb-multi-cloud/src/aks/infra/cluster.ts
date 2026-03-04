// Azure infrastructure: AKS cluster + managed identities + role assignments.
// Sized for CockroachDB: 3x Standard_D4s_v5 (4 vCPU / 16 GiB) worker nodes.

import {
  AksCluster,
  Azure,
  ManagedIdentity,
  RoleAssignment,
} from "@intentius/chant-lexicon-azure";

// ── AKS Cluster ────────────────────────────────────────────────────

export const { cluster } = AksCluster({
  name: "aks-cockroachdb",
  nodeCount: 3,
  vmSize: "Standard_D4s_v5",
  kubernetesVersion: "1.31",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { environment: "production", "managed-by": "chant" },
});

// ── Managed Identities for Workload Identity ──────────────────────

export const externalDnsIdentity = new ManagedIdentity({
  name: "aks-cockroachdb-dns-id",
  location: Azure.ResourceGroupLocation as unknown as string,
  tags: { "managed-by": "chant" },
});

// ── Role Assignments ───────────────────────────────────────────────

// External DNS identity → DNS Zone Contributor
export const dnsContributor = new RoleAssignment({
  name: "[guid(resourceGroup().id, 'aks-cockroachdb-dns-contributor')]",
  principalId: "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', 'aks-cockroachdb-dns-id')).principalId]",
  roleDefinitionId: "[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'befefa01-2a29-4197-83a8-272ff33ce314')]",
  principalType: "ServicePrincipal",
});
