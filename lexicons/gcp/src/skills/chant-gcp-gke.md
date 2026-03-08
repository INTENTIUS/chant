---
skill: chant-gcp-gke
description: End-to-end GKE workflow bridging GCP infrastructure and Kubernetes workloads
user-invocable: true
---

# GKE End-to-End Workflow

## Overview

This skill bridges two lexicons:
- **`@intentius/chant-lexicon-gcp`** — GKE cluster, node pool, service accounts, IAM bindings, Cloud DNS (Config Connector)
- **`@intentius/chant-lexicon-k8s`** — Kubernetes workloads, Workload Identity, GCE Ingress, storage, observability (K8s YAML)

## Architecture

```
GCP Lexicon (Config Connector)           K8s Lexicon (kubectl apply)
┌─────────────────────────────┐         ┌─────────────────────────────────┐
│ VPC + Subnets + Cloud NAT   │         │ NamespaceEnv (quotas)           │
│ GKE Cluster + Node Pool     │         │ AutoscaledService (app)         │
│ GCP Service Accounts        │──GSA──→ │ WorkloadIdentityServiceAccount  │
│ IAM Policy Members          │         │ GCE Ingress + GkeExternalDns    │
│ Cloud DNS Managed Zone      │         │ GcePdStorageClass               │
└─────────────────────────────┘         │ GkeFluentBitAgent (logs)        │
                                        │ GkeOtelCollector (traces)       │
                                        └─────────────────────────────────┘
```

## Step 1: Bootstrap (one-time)

Creates a GKE cluster with Config Connector enabled and configures Workload Identity:

```bash
export GCP_PROJECT_ID=<your-project>
npm run bootstrap
```

This enables required APIs, creates the cluster, sets up a Config Connector service account with editor/IAM/DNS roles, and waits for the controller to be ready.

## Step 2: Build

```bash
# Build Config Connector YAML
chant build src --lexicon gcp -o config.yaml

# Build K8s workload YAML
chant build src --lexicon k8s -o k8s.yaml
```

Or use the combined script:

```bash
npm run build
```

## Step 3: Deploy Config Connector Resources

```bash
npm run deploy-infra
# Applies config.yaml — Config Connector reconciles GCP resources
```

Key GCP resources created:
- **GKE Cluster** — control plane with Workload Identity enabled
- **Node Pool** — worker nodes
- **GCP Service Accounts** — app SA, ExternalDNS SA, logging SA, monitoring SA
- **IAM Policy Members** — Workload Identity bindings + role grants
- **Cloud DNS Managed Zone** — for ExternalDNS

## Step 4: Load Outputs

```bash
npm run load-outputs
```

Populates `.env` with GCP service account emails and DNS zone info from the live cluster. These values flow into K8s composite props via `config.ts`.

## Step 5: Deploy K8s Workloads

```bash
npm run build:k8s    # Rebuild with real values from .env
npm run apply        # kubectl apply -f k8s.yaml
```

### Key K8s composites for GKE

```typescript
import {
  NamespaceEnv,
  AutoscaledService,
  WorkloadIdentityServiceAccount,
  GkeExternalDnsAgent,
  GcePdStorageClass,
  GkeFluentBitAgent,
  GkeOtelCollector,
} from "@intentius/chant-lexicon-k8s";

// 1. Namespace with quotas and network isolation
const ns = NamespaceEnv({
  name: "prod",
  cpuQuota: "16",
  memoryQuota: "32Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultDenyIngress: true,
});

// 2. Workload Identity ServiceAccount (use GSA email from Config Connector outputs)
const wi = WorkloadIdentityServiceAccount({
  name: "app-sa",
  gcpServiceAccountEmail: "app@my-project.iam.gserviceaccount.com",  // from .env
  namespace: "prod",
});

// 3. Application with autoscaling
const app = AutoscaledService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  namespace: "prod",
});

// 4. ExternalDNS for Cloud DNS
const dns = GkeExternalDnsAgent({
  gcpServiceAccountEmail: "dns@my-project.iam.gserviceaccount.com",
  gcpProjectId: "my-project",
  domainFilters: ["example.com"],
});

// 5. Storage
const storage = GcePdStorageClass({ name: "pd-balanced", type: "pd-balanced" });

// 6. Observability
const logging = GkeFluentBitAgent({
  clusterName: "my-cluster",
  projectId: "my-project",
});

const tracing = GkeOtelCollector({
  clusterName: "my-cluster",
  projectId: "my-project",
});
```

## Step 6: Verify

```bash
npm run status
kubectl get pods -n prod
kubectl get ingress -n prod
kubectl logs -n gke-logging -l app.kubernetes.io/name=fluent-bit
```

## Cleanup

```bash
npm run teardown
```

Delete order matters:
1. **K8s workloads** — drains load balancers
2. **Config Connector resources** — deletes GCP infra (SAs, IAM, DNS)
3. **Config Connector SA** — the CC controller's own SA
4. **GKE cluster** — the bootstrap cluster itself

## Cross-Lexicon Value Flow

Config Connector outputs flow into K8s composite props via `.env`:

| Config Connector Output | K8s Composite Prop |
|------------------------|-------------------|
| App GSA email | `WorkloadIdentityServiceAccount.gcpServiceAccountEmail` |
| ExternalDNS GSA email | `GkeExternalDnsAgent.gcpServiceAccountEmail` |
| Logging GSA email | `GkeFluentBitAgent.gcpServiceAccountEmail` |
| Monitoring GSA email | `GkeOtelCollector.gcpServiceAccountEmail` |
| GCP Project ID | `GkeExternalDnsAgent.gcpProjectId`, `GkeFluentBitAgent.projectId`, `GkeOtelCollector.projectId` |
| Cluster name | `GkeFluentBitAgent.clusterName`, `GkeOtelCollector.clusterName` |

## GKE Init Template

Scaffold a dual-lexicon GKE project:

```bash
chant init --lexicon gcp --template gke
```

This creates:
- `src/infra/` — GKE cluster, node pool, service accounts, IAM (GCP lexicon)
- `src/k8s/` — namespace, app, ingress, storage (K8s lexicon)
- `package.json` with both `@intentius/chant-lexicon-gcp` and `@intentius/chant-lexicon-k8s`
