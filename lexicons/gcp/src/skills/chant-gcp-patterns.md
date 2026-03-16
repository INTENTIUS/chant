---
skill: chant-gcp-patterns
description: Advanced GCP Config Connector patterns
user-invocable: true
---

# Advanced GCP Config Connector Patterns with Chant

## Overview

Advanced patterns for GCP Config Connector manifest generation with chant, covering
resource references, annotations, pseudo-parameters, composites, multi-project
patterns, and parameters/outputs.

## Resource Reference Linking

Config Connector resources reference each other using `resourceRef` fields.

### By Name (same namespace)

Reference a resource within the same Kubernetes namespace:

```ts
export const network = new VPCNetwork({ autoCreateSubnetworks: false });

export const subnet = new ComputeSubnetwork({
  networkRef: { name: network },
  ipCidrRange: "10.0.0.0/24",
  region: "us-central1",
});
```

Serializes to:

```yaml
spec:
  networkRef:
    name: my-network
```

### By External Reference (cross-project)

Reference a resource in another GCP project or managed externally:

```ts
export const subnet = new ComputeSubnetwork({
  networkRef: {
    external: "projects/shared-vpc-project/global/networks/shared-vpc",
  },
  ipCidrRange: "10.0.1.0/24",
  region: "us-central1",
});
```

External refs bypass WGC111 (dangling reference check) since they reference
resources outside the template.

## Default Annotations and Labels

### defaultAnnotations

Apply project-wide annotations to all Config Connector resources:

```ts
import { defaultAnnotations, GCP } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
  "cnrm.cloud.google.com/deletion-policy": "abandon",
});
```

All resources in the output will receive these annotations in `metadata.annotations`.

### defaultLabels

Apply project-wide Kubernetes labels:

```ts
import { defaultLabels } from "@intentius/chant-lexicon-gcp";

export const labels = defaultLabels({
  "app.kubernetes.io/managed-by": "chant",
  "environment": "production",
});
```

All resources will receive these labels in `metadata.labels`.

## Pseudo-Parameters

Pseudo-parameters are resolved at deploy time. Use the `GCP` namespace:

```ts
import { GCP } from "@intentius/chant-lexicon-gcp";

// GCP.ProjectId  → resolves to the target GCP project ID
// GCP.Region     → resolves to the target region
// GCP.Zone       → resolves to the target zone
```

Usage in annotations:

```ts
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
```

Individual imports also work:

```ts
import { ProjectId, Region, Zone } from "@intentius/chant-lexicon-gcp";
```

## Composites

Composites are higher-level abstractions that create multiple related Config Connector
resources with secure defaults.

### GkeCluster

GKE cluster with node pool, workload identity, and autoscaling:

```ts
import { GkeCluster } from "@intentius/chant-lexicon-gcp";

const { cluster, nodePool } = GkeCluster({
  name: "my-cluster",
  location: "us-central1",
  machineType: "e2-medium",
  minNodeCount: 1,
  maxNodeCount: 10,
});

export { cluster, nodePool };
```

### CloudRunService

Cloud Run service with optional public access IAM:

```ts
import { CloudRunService } from "@intentius/chant-lexicon-gcp";

const { service } = CloudRunService({
  name: "my-api",
  image: "gcr.io/my-project/my-api:latest",
  location: "us-central1",
  port: 8080,
});

export { service };
```

### CloudSqlInstance

SQL instance with database and user:

```ts
import { CloudSqlInstance } from "@intentius/chant-lexicon-gcp";

const { instance, database, user } = CloudSqlInstance({
  name: "my-db",
  databaseVersion: "POSTGRES_15",
  tier: "db-custom-2-8192",
});

export { instance, database, user };
```

### GcsBucket

Storage bucket with encryption, uniform access, and lifecycle:

```ts
import { GcsBucket } from "@intentius/chant-lexicon-gcp";

const { bucket } = GcsBucket({
  name: "my-data-bucket",
  location: "US",
  storageClass: "STANDARD",
  kmsKeyName: "projects/p/locations/l/keyRings/kr/cryptoKeys/k",
  lifecycleDeleteAfterDays: 365,
});

export { bucket };
```

### VpcNetwork

VPC network with subnets, firewall rules, and Cloud NAT:

```ts
import { VpcNetwork } from "@intentius/chant-lexicon-gcp";

const { network, subnets, firewall, router, nat } = VpcNetwork({
  name: "my-vpc",
  subnets: [
    { name: "app-subnet", ipCidrRange: "10.0.1.0/24", region: "us-central1" },
    { name: "data-subnet", ipCidrRange: "10.0.2.0/24", region: "us-central1" },
  ],
});

export { network, subnets, firewall, router, nat };
```

### PubSubPipeline

Topic + subscription with optional dead-letter queue:

```ts
import { PubSubPipeline } from "@intentius/chant-lexicon-gcp";

const { topic, subscription, dlqTopic } = PubSubPipeline({
  name: "order-events",
  enableDeadLetterQueue: true,
  maxDeliveryAttempts: 5,
});

export { topic, subscription, dlqTopic };
```

### CloudFunctionWithTrigger

Cloud Function with source bucket and trigger:

```ts
import { CloudFunctionWithTrigger } from "@intentius/chant-lexicon-gcp";

const { function: fn, sourceBucket } = CloudFunctionWithTrigger({
  name: "process-orders",
  runtime: "nodejs20",
  entryPoint: "handler",
  triggerType: "pubsub",
  pubsubTopicName: "order-events",
});

export { fn, sourceBucket };
```

### PrivateService

Private service networking (VPC peering for managed services):

```ts
import { PrivateService } from "@intentius/chant-lexicon-gcp";

const { address, connection } = PrivateService({
  name: "private-svc",
  networkName: "my-vpc",
  prefixLength: 16,
});

export { address, connection };
```

### ManagedCertificate

Google-managed SSL certificate with optional HTTPS proxy:

```ts
import { ManagedCertificate } from "@intentius/chant-lexicon-gcp";

const { certificate } = ManagedCertificate({
  name: "my-cert",
  domains: ["example.com", "www.example.com"],
});

export { certificate };
```

### SecureProject

GCP project with audit logging, API enablement, and owner IAM:

```ts
import { SecureProject } from "@intentius/chant-lexicon-gcp";

const { project, auditConfig, services } = SecureProject({
  name: "my-secure-project",
  orgId: "123456789",
  billingAccountRef: { external: "AAAAAA-BBBBBB-CCCCCC" },
  owner: "user:admin@example.com",
  enabledApis: ["compute.googleapis.com", "container.googleapis.com"],
});

export { project, auditConfig, services };
```

## Multi-Project Patterns

### Project Annotation

Bind resources to a specific GCP project:

```ts
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
```

### ConfigConnectorContext

When managing multiple projects, use ConfigConnectorContext per namespace:

```yaml
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: project-a
spec:
  googleServiceAccount: cnrm-system@project-a.iam.gserviceaccount.com
```

### Cross-Project References

Use external refs to reference resources in other projects:

```ts
export const peering = new ComputeNetworkPeering({
  networkRef: { name: localNetwork },
  peerNetworkRef: {
    external: "projects/other-project/global/networks/other-vpc",
  },
});
```

## CoreParameter and StackOutput

### CoreParameter

Define deploy-time parameters:

```ts
import { CoreParameter } from "@intentius/chant";

export const environment = new CoreParameter({
  name: "environment",
  type: "string",
  default: "dev",
});

export const region = new CoreParameter({
  name: "region",
  type: "string",
  default: "us-central1",
});
```

### StackOutput

Export values from the synthesized output:

```ts
import { StackOutput } from "@intentius/chant";

export const bucketName = new StackOutput({
  name: "bucketName",
  value: bucket,
});

export const clusterEndpoint = new StackOutput({
  name: "clusterEndpoint",
  value: cluster,
});
```
