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

### GceIngress — Ingress with GCE ingress class annotations

```typescript
import { GceIngress } from "@intentius/chant-lexicon-k8s";

const { ingress } = GceIngress({
  name: "api-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  staticIpName: "api-ip",
  managedCertificate: "api-cert",
  namespace: "prod",
});
```

Features:
- Sets `kubernetes.io/ingress.class: "gce"` annotation
- `staticIpName` binds a reserved global static IP via `kubernetes.io/ingress.global-static-ip-name`
- `managedCertificate` attaches a GKE-managed SSL certificate via `networking.gke.io/managed-certificates`
- Auto-generates FrontendConfig for SSL redirect when `managedCertificate` is set (override with `sslRedirect: false`)
- Pairs naturally with Config Connector `ComputeAddress` resources for static IPs

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

**Props:** `gcpServiceAccountEmail` (required), `gcpProjectId` (required), `domainFilters` (required), `txtOwnerId?`, `source?` (string or string[], default: `"service"`), `name?` (default: `"external-dns"`), `namespace?` (default: `"kube-system"`), `image?` (default: `"registry.k8s.io/external-dns/external-dns:v0.14.2"`), `labels?`, `defaults?`

**Returns:** `{ deployment, serviceAccount, clusterRole, clusterRoleBinding }`

To watch both Services and Ingresses, pass `source: ["service", "ingress"]`.

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

### CockroachDbCluster — multi-node CockroachDB StatefulSet

```typescript
import { CockroachDbCluster } from "@intentius/chant-lexicon-k8s";

const crdb = CockroachDbCluster({
  name: "cockroachdb",
  namespace: "crdb-east",
  replicas: 3,
  image: "cockroachdb/cockroach:v24.3.4",
  storageSize: "100Gi",
  storageClassName: "pd-ssd",
  cpuLimit: "2",
  memoryLimit: "8Gi",
  locality: "region=us-east1,zone=us-east1-b",
  joinAddresses: ["cockroachdb-0.east.crdb.example.com", "cockroachdb-0.west.crdb.example.com"],
  secure: true,
  skipInit: false,       // true on non-bootstrapping regions
  skipCertGen: true,     // true when certs are provisioned externally
  advertiseHostDomain: "east.crdb.example.com",
  extraCertNodeAddresses: [
    "cockroachdb-0.east.crdb.example.com",
    "cockroachdb-1.east.crdb.example.com",
    "cockroachdb-2.east.crdb.example.com",
  ],
});

export const {
  serviceAccount, role, roleBinding, clusterRole, clusterRoleBinding,
  publicService, headlessService, pdb, statefulSet,
  initJob,     // only when skipInit: false
  certGenJob,  // only when skipCertGen: false
} = crdb;
```

**Key props:**
- `secure` — enables TLS node-to-node and client comms (default: `false`)
- `skipInit` — skip `cockroach init`; set `true` on all regions except the one that bootstraps the cluster
- `skipCertGen` — skip cert generation Job; use when certs are managed externally (e.g. `generate-certs.sh`)
- `advertiseHostDomain` — hostname suffix CockroachDB advertises to peers; must resolve via ExternalDNS or similar
- `extraCertNodeAddresses` — SANs added to node certs for cross-region RPC; list all pod FQDNs that peers will dial
- `locality` — CockroachDB locality string (`region=...,zone=...`); used for data placement and rebalancing
- `joinAddresses` — seed peer addresses used at startup; include one node from each region

**`defaults`** allow deep-merging arbitrary fields onto any generated resource:
- `defaults.serviceAccount` — e.g. add `iam.gke.io/gcp-service-account` annotation for Workload Identity
- `defaults.publicService` — e.g. add `cloud.google.com/backend-config` + `cloud.google.com/app-protocols` annotations for GCE Ingress
- `defaults.headlessService` — e.g. add `external-dns.alpha.kubernetes.io/hostname` for ExternalDNS registration

### ConfigConnectorContext — Config Connector namespace bootstrap

```typescript
import { ConfigConnectorContext } from "@intentius/chant-lexicon-k8s";

const { context } = ConfigConnectorContext({
  googleServiceAccountEmail: "cc-sa@my-project.iam.gserviceaccount.com",
  namespace: "config-connector",
  stateIntoSpec: "Absent",
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
