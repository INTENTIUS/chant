---
skill: chant-gcp
description: Build, validate, and deploy GCP Config Connector manifests from a chant project
user-invocable: true
---

# GCP Config Connector Operational Playbook

## How chant and Config Connector relate

chant is a **synthesis compiler** — it compiles TypeScript source files into Config Connector YAML manifests. `chant build` does not call GCP APIs; synthesis is pure and deterministic. Config Connector resources are Kubernetes objects, so the optional `chant state snapshot` command queries the Kubernetes API to capture deployment metadata (resource status, conditions, observed state) for observability. Your job as an agent is to bridge synthesis and deployment:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **kubectl** for: apply, rollback, monitoring, troubleshooting

The source of truth for infrastructure is the TypeScript in `src/`. The generated YAML manifests are intermediate artifacts.

## Prerequisites

1. A GKE cluster with Config Connector installed and the controller running
2. A ConfigConnectorContext resource per namespace binding an IAM service account
3. A GCP Service Account with appropriate IAM roles for the resources you declare
4. `kubectl` configured with credentials for the target cluster
5. `chant` installed (`npm install --save-dev @intentius/chant @intentius/chant-lexicon-gcp`)
6. Workload Identity enabled on the GKE node pool (recommended over key-based auth)

Verify Config Connector is healthy before your first deploy:

```bash
kubectl get configconnectorcontexts -A
kubectl get pods -n cnrm-system
```

Both should show `Running` / `Healthy`. If the controller pod is crashlooping, no resources will reconcile.

## Build and validate workflow

### 1. Lint the source

```bash
chant lint src/
```

Runs pre-synth static analysis on your TypeScript. Fix all warnings before building.

### 2. Build manifests

```bash
chant build src/ --output manifests.yaml
```

Synthesizes TypeScript into Config Connector YAML and runs post-synth checks on the output.

### 3. Server-side dry run

```bash
kubectl apply -f manifests.yaml --dry-run=server
```

Validates the manifests against the Kubernetes API server schema. Catches CRD version mismatches, unknown fields, and missing namespaces.

### What each step catches

| Step | Rule IDs | Catches | When to run |
|------|----------|---------|-------------|
| `chant lint` | WGC001 | Hardcoded project IDs | Every edit |
| `chant lint` | WGC002 | Hardcoded regions | Every edit |
| `chant lint` | WGC003 | Public IAM bindings (allUsers/allAuthenticatedUsers) | Every edit |
| `chant build` (post-synth) | WGC101 | Missing encryption (CMEK or Google-managed) | Before apply |
| `chant build` (post-synth) | WGC102 | Public IAM bindings in synthesized output | Before apply |
| `chant build` (post-synth) | WGC103 | Missing project annotation on resource | Before apply |
| `chant build` (post-synth) | WGC104 | Missing uniform bucket-level access on GCS | Before apply |
| `chant build` (post-synth) | WGC105 | Public Cloud SQL (ipConfiguration.ipv4Enabled) | Before apply |
| `chant build` (post-synth) | WGC106 | Missing deletion policy annotation | Before apply |
| `chant build` (post-synth) | WGC107 | Missing versioning on GCS buckets | Before apply |
| `chant build` (post-synth) | WGC108 | Missing backup configuration on Cloud SQL | Before apply |
| `chant build` (post-synth) | WGC109 | Open firewall rules (0.0.0.0/0) | Before apply |
| `chant build` (post-synth) | WGC110 | Missing key rotation period on KMS keys | Before apply |
| `chant build` (post-synth) | WGC111 | Dangling resource reference (resourceRef target missing) | Before apply |
| `chant build` (post-synth) | WGC112 | Missing or invalid apiVersion on CRD | Before apply |
| `chant build` (post-synth) | WGC113 | Alpha API version (unstable, may break) | Before apply |
| `chant build` (post-synth) | WGC201 | Missing managed-by label | Before apply |
| `chant build` (post-synth) | WGC202 | Missing Workload Identity on GKE node pool | Before apply |
| `chant build` (post-synth) | WGC203 | Overly broad cloud-platform OAuth scope | Before apply |
| `chant build` (post-synth) | WGC204 | Missing shielded VM config on GKE nodes | Before apply |
| `chant build` (post-synth) | WGC301 | No audit logging configured on project | Before apply |
| `chant build` (post-synth) | WGC302 | Service API not enabled for resource type | Before apply |
| `chant build` (post-synth) | WGC303 | Missing VPC Service Controls perimeter | Before apply |
| `chant build` (post-synth) | WGC401 | Unknown spec field (typo or wrong CRD version) | Before apply |
| `chant build` (post-synth) | WGC402 | Missing required field in spec | Before apply |
| `chant build` (post-synth) | WGC403 | Type/structure mismatch (string vs object, etc.) | Before apply |
| `kubectl --dry-run=server` | — | CRD not installed, namespace missing, schema violations | Before apply |

## Applying to Kubernetes

```bash
# 1. Build
chant build src/ --output manifests.yaml

# 2. See what changed since last deploy (compares current build against last snapshot's digest)
chant state diff staging gcp

# 3. Diff against live cluster state
kubectl diff -f manifests.yaml

# 4. Dry run against API server
kubectl apply -f manifests.yaml --dry-run=server

# 5. Apply
kubectl apply -f manifests.yaml
```

## Diffing and change preview

Use `kubectl diff` to see exactly what will change before applying:

```bash
kubectl diff -f manifests.yaml
```

This compares your local manifests against the live cluster state. Exit code 0 means no changes; exit code 1 means differences exist. The output is a unified diff showing additions, removals, and modifications.

For chant-level diffing (comparing against the last snapshot rather than live state):

```bash
chant state diff staging gcp
```

This is faster (no cluster access needed) and works offline, but only reflects the last time you captured a snapshot.

## Resource reference patterns

Config Connector resources reference each other using `resourceRef`:

```yaml
# By name (same namespace)
resourceRef:
  name: my-network

# By external reference (cross-project)
resourceRef:
  external: projects/my-project/global/networks/my-network
```

Use in-namespace `name` references when both resources are in the same chant project and namespace. Use `external` references for pre-existing resources or cross-project dependencies.

### Common reference patterns

| Source resource | Target resource | Reference field |
|----------------|----------------|-----------------|
| ComputeSubnetwork | ComputeNetwork | `spec.networkRef` |
| ComputeFirewall | ComputeNetwork | `spec.networkRef` |
| SQLInstance | ComputeNetwork | `spec.settings.ipConfiguration.privateNetworkRef` |
| IAMPolicyMember | Any | `spec.resourceRef` |
| DNSRecordSet | DNSManagedZone | `spec.managedZoneRef` |
| ContainerNodePool | ContainerCluster | `spec.clusterRef` |

## Project binding

Bind resources to a GCP project via annotations:

```yaml
metadata:
  annotations:
    cnrm.cloud.google.com/project-id: my-project
```

Or use defaultAnnotations in chant:

```typescript
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
```

### Folder and org binding

For organization-level resources, use the equivalent annotations:

```yaml
# Folder-scoped
cnrm.cloud.google.com/folder-id: "123456789"

# Organization-scoped
cnrm.cloud.google.com/organization-id: "987654321"
```

## Composites reference

Composites group related Config Connector resources with secure defaults. Each returns an object containing the individual resources.

| Composite | Creates | Secure defaults |
|-----------|---------|-----------------|
| `GkeCluster` | ContainerCluster + ContainerNodePool | Workload Identity, shielded nodes, private cluster, VPC-native |
| `CloudRunServiceComposite` | RunService + IAMPolicyMember | No allUsers by default, concurrency limits, CPU throttling |
| `CloudSqlInstance` | SQLInstance + SQLDatabase + SQLUser | Private IP, backups enabled, deletion protection, SSL required |
| `GcsBucket` | StorageBucket | Uniform access, versioning, encryption, deletion policy |
| `VpcNetwork` | ComputeNetwork + ComputeSubnetwork(s) + ComputeFirewall(s) | Private Google Access, flow logs, no default 0.0.0.0/0 rule |
| `PubSubPipeline` | PubSubTopic + PubSubSubscription | Message retention, dead letter topic, ack deadline |
| `CloudFunctionWithTrigger` | CloudFunction + EventTrigger or HttpsTrigger | VPC connector, ingress settings, service account |
| `PrivateService` | ComputeGlobalAddress + ServiceNetworkingConnection | RFC 1918 range, automatic peering |
| `ManagedCertificate` | ComputeManagedSslCertificate | Auto-renewal via Google-managed cert |
| `SecureProject` | Project + IAMAuditConfig + essential Service resources | Audit logging, required APIs enabled, org policy constraints |

### Example: GKE cluster with secure defaults

```typescript
import { GkeCluster } from "@intentius/chant-lexicon-gcp";

const { cluster, nodePool } = GkeCluster({
  name: "prod-cluster",
  location: "us-central1",
  initialNodeCount: 3,
  minNodeCount: 1,
  maxNodeCount: 5,
  machineType: "e2-standard-4",
});
```

### Example: Cloud SQL with private networking

```typescript
import { CloudSqlInstance, PrivateService } from "@intentius/chant-lexicon-gcp";

const { globalAddress, connection } = PrivateService({
  name: "sql-peering",
  networkName: "default",
});

const { instance, database } = CloudSqlInstance({
  name: "app-db",
  databaseVersion: "POSTGRES_15",
  tier: "db-custom-2-8192",
  privateNetworkRef: { name: "default" },
});
```

## Deploy lifecycle

### 1. Build and validate

```bash
chant build src/ --output manifests.yaml
chant lint src/
kubectl apply -f manifests.yaml --dry-run=server
```

### 2. Apply

```bash
kubectl apply -f manifests.yaml
```

### 3. Wait for Ready

Config Connector resources reconcile asynchronously. Wait for the `Ready` condition:

```bash
# Watch all Config Connector resources
kubectl get gcp -w

# Wait for a specific resource
kubectl wait --for=condition=Ready sqldatabase/app-db --timeout=600s
```

Most resources reconcile in 30-120 seconds. Cloud SQL instances can take 5-10 minutes. GKE clusters can take 10-20 minutes.

### 4. Verify

```bash
# Check all resource statuses
kubectl get gcp

# Detailed status for a specific resource
kubectl describe computeinstance/web-server

# Capture a snapshot for future diffing
chant state snapshot staging gcp
```

### 5. Rollback

To roll back, revert the TypeScript source, rebuild, and reapply:

```bash
git checkout HEAD~1 -- src/
chant build src/ --output manifests.yaml
kubectl apply -f manifests.yaml
```

For emergency rollback of a single resource, delete it from the cluster. Config Connector will NOT delete the underlying GCP resource unless the deletion policy annotation is set to `abandon: false`:

```bash
# Check deletion policy first
kubectl get computeinstance/web-server -o jsonpath='{.metadata.annotations.cnrm\.cloud\.google\.com/deletion-policy}'

# If "abandon" (default), deleting the K8s object leaves the GCP resource intact
kubectl delete computeinstance/web-server
```

## Multi-project patterns

### Namespace-per-project

Create a Kubernetes namespace per GCP project, each with its own ConfigConnectorContext:

```yaml
apiVersion: core.cnrm.cloud.google.com/v1beta1
kind: ConfigConnectorContext
metadata:
  name: configconnectorcontext.core.cnrm.cloud.google.com
  namespace: project-a
spec:
  googleServiceAccount: cnrm-sa@project-a.iam.gserviceaccount.com
```

Then target a namespace when applying:

```bash
kubectl apply -f manifests-project-a.yaml -n project-a
kubectl apply -f manifests-project-b.yaml -n project-b
```

### Cross-project references

Use `external` refs to reference resources in other projects:

```typescript
const subnet = new ComputeSubnetwork({
  name: "app-subnet",
  networkRef: {
    external: "projects/shared-vpc-project/global/networks/shared-vpc",
  },
});
```

### Shared VPC pattern

In a Shared VPC setup, the host project owns the VPC and the service projects consume subnets:

```typescript
// In host project namespace
const { network, subnets } = VpcNetwork({
  name: "shared-vpc",
  subnets: [
    { name: "svc-a-subnet", cidr: "10.0.1.0/24", region: "us-central1" },
    { name: "svc-b-subnet", cidr: "10.0.2.0/24", region: "us-central1" },
  ],
});

// In service project namespace — reference by external
const instance = new ComputeInstance({
  name: "app-vm",
  subnetworkRef: {
    external: "projects/host-project/regions/us-central1/subnetworks/svc-a-subnet",
  },
});
```

## Troubleshooting decision tree

### Resource stuck in a non-Ready state

```
Is the resource status "UpToDate"?
  YES -> Resource is reconciled. Done.
  NO  -> Check the status condition:
    "UpdateFailed"
      -> kubectl describe <resource> — read the Events section
      -> Common causes:
         - IAM permission denied -> Grant the missing role to the Config Connector SA
         - Quota exceeded -> Request quota increase or reduce resource count
         - Invalid field value -> Fix the TypeScript source and rebuild
    "DependencyNotReady"
      -> The resourceRef target hasn't reconciled yet
      -> Check the referenced resource: kubectl get <target-kind>/<target-name>
      -> If the target doesn't exist, add it to your chant source
    "DeletionFailed"
      -> Cannot delete the GCP resource
      -> Check IAM permissions for deletion
      -> Some resources (Cloud SQL, GKE) have deletion protection; disable it first
    "Updating"
      -> Resource is actively being updated. Wait.
      -> If stuck for >10 min: kubectl describe to check for errors
```

### Common error patterns

| Error message | Cause | Fix |
|--------------|-------|-----|
| `Permission denied on resource` | Config Connector SA lacks IAM role | `gcloud projects add-iam-policy-binding` |
| `Resource already exists` | Resource was created outside Config Connector | Use `cnrm.cloud.google.com/state-into-spec: absent` to adopt |
| `Quota exceeded` | Project quota limit reached | Request increase or adjust resource sizing |
| `Invalid value for field` | Spec value rejected by GCP API | Check field constraints in GCP docs |
| `The referenced resource does not exist` | Dangling resourceRef | Ensure the referenced resource is defined and in the same namespace or use `external` |
| `Namespace not found` | Target namespace doesn't exist | `kubectl create namespace <ns>` |
| `no matches for kind` | Config Connector CRD not installed | Install or update Config Connector |
| `alpha API version in use` | Using v1alpha1 CRD that may change | Pin to v1beta1 or v1 if available |

### Adopting existing resources

To bring a pre-existing GCP resource under Config Connector management:

```yaml
metadata:
  annotations:
    cnrm.cloud.google.com/state-into-spec: absent
```

This tells Config Connector to adopt the resource without overwriting its current settings.

## Quick reference commands

| Command | Description |
|---------|-------------|
| `chant build src/` | Synthesize Config Connector manifests |
| `chant build src/ --output manifests.yaml` | Synthesize to a specific file |
| `chant lint src/` | Check for anti-patterns (pre-synth + post-synth) |
| `chant state diff staging gcp` | Compare current build against last snapshot |
| `chant state snapshot staging gcp` | Capture current cluster state |
| `kubectl apply -f manifests.yaml` | Apply manifests to cluster |
| `kubectl apply -f manifests.yaml --dry-run=server` | Validate against API server |
| `kubectl diff -f manifests.yaml` | Preview changes against live state |
| `kubectl get gcp` | List all Config Connector resources |
| `kubectl get gcp -w` | Watch Config Connector resource status |
| `kubectl describe <kind>/<name>` | Detailed resource status and events |
| `kubectl wait --for=condition=Ready <kind>/<name> --timeout=300s` | Block until resource is ready |
| `kubectl delete <kind>/<name>` | Remove from cluster (deletion policy controls GCP resource) |
| `kubectl get configconnectorcontexts -A` | Check Config Connector health |
| `kubectl get pods -n cnrm-system` | Check Config Connector controller pods |
| `kubectl logs -n cnrm-system -l cnrm.cloud.google.com/component=cnrm-controller-manager` | Controller logs |

## Labels and annotations reference

| Annotation / Label | Purpose | Example |
|-------------------|---------|---------|
| `cnrm.cloud.google.com/project-id` | Bind resource to a GCP project | `my-project-id` |
| `cnrm.cloud.google.com/folder-id` | Bind to a folder | `123456789` |
| `cnrm.cloud.google.com/organization-id` | Bind to an org | `987654321` |
| `cnrm.cloud.google.com/deletion-policy` | Control GCP resource on K8s delete | `abandon` (default) or `delete` |
| `cnrm.cloud.google.com/state-into-spec` | Adopt existing resources | `absent` |
| `cnrm.cloud.google.com/force-conflicts` | Allow Config Connector to overwrite | `true` |
| `managed-by` label | Operational tracking (WGC201) | `chant` |
