# AKS Cluster

A Chant Azure example that deploys an Azure Kubernetes Service cluster with a default node pool, built using the `AksCluster` composite.

## Quick Start

```bash
bun run build
```

## What It Does

The stack creates 1 ARM resource:

- **AKS Managed Cluster** — Kubernetes 1.28 cluster with SystemAssigned managed identity, RBAC enabled, 3-node default pool on Standard_D2s_v5 VMs, Azure CNI networking, and Standard load balancer

`AksCluster` sets up production defaults including RBAC, managed identity, and VirtualMachineScaleSets-backed node pools.

## Project Structure

```
src/
├── main.ts       # AksCluster composite instantiation
└── tags.ts       # Project-wide default tags
```

## Patterns Demonstrated

1. **Managed identity** — `SystemAssigned` identity for secure cluster-to-Azure-service communication
2. **RBAC by default** — Kubernetes RBAC is enabled for access control
3. **Agent pool profiles** — Declarative node pool configuration with VM size, count, and OS type
