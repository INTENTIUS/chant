---
skill: chant-k8s-gke
description: GKE-specific Kubernetes patterns and composites
user-invocable: true
---

# GKE Kubernetes Patterns

## GKE Composites Overview

These composites produce K8s YAML with GKE-specific annotations and configurations.

### WorkloadIdentityServiceAccount — ServiceAccount with GCP SA annotation

```typescript
import { WorkloadIdentityServiceAccount } from "@intentius/chant-lexicon-k8s";

const { serviceAccount, role, roleBinding } = WorkloadIdentityServiceAccount({
  name: "app-sa",
  gcpServiceAccountEmail: "app@my-project.iam.gserviceaccount.com",
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
  namespace: "prod",
});
```

Annotates the ServiceAccount with `iam.gke.io/gcp-service-account` for GKE Workload Identity.

### GkeGateway — Gateway API with GKE gateway classes

```typescript
import { GkeGateway } from "@intentius/chant-lexicon-k8s";

const { gateway, httpRoute } = GkeGateway({
  name: "api-gateway",
  gatewayClassName: "gke-l7-global-external-managed",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  certificateName: "api-cert",
  namespace: "prod",
});
```

Gateway class options:
- `gke-l7-global-external-managed` — Global external (default)
- `gke-l7-regional-external-managed` — Regional external
- `gke-l7-rilb` — Regional internal

### GcePdStorageClass — StorageClass for GCE Persistent Disk CSI

```typescript
import { GcePdStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = GcePdStorageClass({
  name: "pd-balanced",
  type: "pd-balanced",
  replicationType: "none",
  allowVolumeExpansion: true,
});
```

Disk types: `pd-standard`, `pd-ssd`, `pd-balanced` (default), `pd-extreme`.

### FilestoreStorageClass — StorageClass for Filestore CSI (ReadWriteMany)

```typescript
import { FilestoreStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = FilestoreStorageClass({
  name: "filestore-shared",
  tier: "standard",
  network: "my-vpc",
});
```

Use Filestore when you need ReadWriteMany (shared across pods/nodes). Use GCE PD for ReadWriteOnce (single pod).

### GkeExternalDnsAgent — ExternalDNS for Cloud DNS

```typescript
import { GkeExternalDnsAgent } from "@intentius/chant-lexicon-k8s";

const result = GkeExternalDnsAgent({
  gcpServiceAccountEmail: "dns@my-project.iam.gserviceaccount.com",
  gcpProjectId: "my-project",
  domainFilters: ["example.com"],
  txtOwnerId: "my-cluster",
});
```

### GkeFluentBitAgent — DaemonSet for Cloud Logging

```typescript
import { GkeFluentBitAgent } from "@intentius/chant-lexicon-k8s";

const result = GkeFluentBitAgent({
  clusterName: "my-cluster",
  projectId: "my-project",
  gcpServiceAccountEmail: "logging@my-project.iam.gserviceaccount.com",
});
```

### GkeOtelCollector — OTel for Cloud Trace + Cloud Monitoring

```typescript
import { GkeOtelCollector } from "@intentius/chant-lexicon-k8s";

const result = GkeOtelCollector({
  clusterName: "my-cluster",
  projectId: "my-project",
  gcpServiceAccountEmail: "monitoring@my-project.iam.gserviceaccount.com",
});
```

### ConfigConnectorContext — Config Connector namespace bootstrap

```typescript
import { ConfigConnectorContext } from "@intentius/chant-lexicon-k8s";

const { context } = ConfigConnectorContext({
  googleServiceAccountEmail: "cc-sa@my-project.iam.gserviceaccount.com",
  namespace: "config-connector",
  stateIntoSpec: "absent",
});
```

Required when using Config Connector to manage GCP resources from within the cluster.

## Workload Identity vs Key-Based Auth

| Feature | Workload Identity | Key-based (JSON key file) |
|---------|------------------|--------------------------|
| K8s annotation needed | Yes (`iam.gke.io/gcp-service-account`) | No |
| Composite available | **WorkloadIdentityServiceAccount** | None needed (mount key as Secret) |
| Setup | GKE cluster WI enabled + IAM binding | Create key → K8s Secret → volume mount |
| Security | No long-lived credentials, auto-rotated | Static key, must rotate manually |
| When to use | Always (recommended) | Legacy workloads, non-GKE clusters |

Workload Identity is the recommended approach for all GKE workloads. Key-based auth requires no K8s-side composite — create a Secret from the JSON key and mount it.

## Config Connector Considerations

Config Connector (CC) runs as a GKE add-on and manages GCP resources declaratively via K8s CRDs:
- **Bootstrap cluster required** — CC needs an existing GKE cluster to run in; use `npm run bootstrap` to create one
- **CC service account** — a GCP SA with editor/IAM roles, bound to the CC controller pod via Workload Identity
- **Reconciliation** — CC continuously reconciles; deleting a CC resource deletes the underlying GCP resource
- **ConfigConnectorContext** — use the composite to configure CC per-namespace (SA email, stateIntoSpec policy)

## GKE Add-ons

Common add-ons managed via GKE (not K8s manifests):
- **Config Connector** — manage GCP resources as K8s CRDs
- **Workload Identity** — pod-to-GCP-SA identity federation (required for WorkloadIdentityServiceAccount)
- **GKE Gateway Controller** — Gateway API implementation (required for GkeGateway)
- **GKE managed Prometheus** — alternative to GkeOtelCollector for metrics
- **GKE Dataplane V2** — eBPF-based networking with built-in NetworkPolicy enforcement
- **Filestore CSI driver** — required for FilestoreStorageClass
- **Compute Engine persistent disk CSI driver** — enabled by default, required for GcePdStorageClass

Configure add-ons via the GCP lexicon (`@intentius/chant-lexicon-gcp`) Config Connector resources.
