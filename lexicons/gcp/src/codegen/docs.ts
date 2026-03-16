/**
 * GCP Config Connector documentation generator.
 *
 * Produces a standalone Starlight docs site at lexicons/gcp/docs/.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { docsPipeline, writeDocsSite, type DocsConfig } from "@intentius/chant/codegen/docs";

/**
 * Extract service name from GCP resource type: "GCP::Compute::Instance" → "Compute"
 */
function serviceFromType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1] : "Other";
}

const overview = `The **GCP Config Connector** lexicon provides full support for defining Google Cloud infrastructure using chant's declarative TypeScript syntax. Resources are serialized to Config Connector YAML manifests.

This lexicon is generated from the official [Config Connector CRDs](https://github.com/GoogleCloudPlatform/k8s-config-connector) and includes coverage for 300+ resource types across 80+ GCP services.

New? Start with the [Getting Started](/chant/lexicons/gcp/getting-started/) guide.

Install it with:

\`\`\`bash
npm install --save-dev @intentius/chant-lexicon-gcp
\`\`\`

## Quick Start

\`\`\`typescript
import { StorageBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const bucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});
\`\`\`

The lexicon provides **300+ resource types** across Compute, Storage, IAM, Networking, Container, SQL, PubSub, and more, plus composites (GkeCluster, CloudRunService, CloudSqlInstance, GcsBucket, VpcNetwork, PubSubPipeline, CloudFunctionWithTrigger, PrivateService, ManagedCertificate, SecureProject) for common patterns.
`;

const outputFormat = `The GCP lexicon serializes resources into **Config Connector YAML manifests** (Kubernetes CRDs).

## Building

Run \`chant build\` to produce Config Connector YAML from your declarations:

\`\`\`bash
chant build
# Writes dist/manifests.yaml
\`\`\`

The generated manifests include:

- \`apiVersion\` and \`kind\` (Config Connector CRD)
- \`metadata\` with name, labels, and annotations
- \`spec\` with the resource configuration

## Key conversions

| Chant (TypeScript) | YAML output | Rule |
|--------------------|-------------|------|
| \`export const myBucket = new StorageBucket({...})\` | \`metadata.name: my-bucket\` | Export name → kebab-case |
| \`defaultLabels({...})\` | Merged into all resources | Project-wide label injection |
| \`defaultAnnotations({...})\` | Merged into all resources | Project-wide annotation injection |

## Applying

Apply to a Kubernetes cluster with Config Connector installed:

\`\`\`bash
# Dry run
kubectl apply -f dist/manifests.yaml --dry-run=server

# Apply
kubectl apply -f dist/manifests.yaml
\`\`\`

## Compatibility

The output is compatible with:
- kubectl apply/diff
- Config Connector controller on GKE
- ArgoCD / Flux GitOps controllers
- Kustomize (as a base)`;

/**
 * Generate documentation for the GCP Config Connector lexicon.
 */
export async function generateDocs(opts?: { verbose?: boolean }): Promise<void> {
  const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

  const config: DocsConfig = {
    name: "gcp",
    displayName: "GCP Config Connector",
    description: "Typed constructors for GCP Config Connector resource manifests",
    distDir: join(pkgDir, "dist"),
    outDir: join(pkgDir, "docs"),
    overview,
    outputFormat,
    serviceFromType,
    srcDir: join(pkgDir, "src"),
    basePath: "/chant/lexicons/gcp/",
    extraPages: [
      {
        slug: "getting-started",
        title: "Getting Started",
        description: "Install chant and deploy your first GCP resource in 5 minutes",
        content: `## What is chant?

Chant is a TypeScript-to-YAML compiler. You write typed TypeScript declarations, and chant outputs Config Connector YAML manifests that can be applied to a GKE cluster with Config Connector installed.

## Prerequisites

1. A GKE cluster with [Config Connector](https://cloud.google.com/config-connector/docs/overview) installed
2. A \`ConfigConnectorContext\` resource configured per namespace
3. A GCP Service Account bound to the Config Connector controller

## Install

\`\`\`bash
npm install --save-dev @intentius/chant @intentius/chant-lexicon-gcp
\`\`\`

## Your first resource

The fastest path is the **GcsBucket** composite — one function call that produces a properly configured Storage bucket:

\`\`\`typescript
// src/infra.gcp.ts
import { GcsBucket } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations, GCP } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

const { bucket } = GcsBucket({
  name: "my-data-bucket",
  location: "US",
  versioning: true,
});

export { bucket };
\`\`\`

## Build and deploy

\`\`\`bash
# Generate Config Connector YAML
chant build --output dist/manifests.yaml

# Validate against the cluster API (no changes applied)
kubectl apply -f dist/manifests.yaml --dry-run=server

# Apply
kubectl apply -f dist/manifests.yaml
\`\`\`

## Using resource constructors

\`\`\`typescript
import { StorageBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";

export const bucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});

export const reader = new IAMPolicyMember({
  member: "serviceAccount:app@my-project.iam.gserviceaccount.com",
  role: "roles/storage.objectViewer",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: bucket,
  },
});
\`\`\`

## Next steps

- [Config Connector Concepts](/chant/lexicons/gcp/config-connector-concepts/) — resource structure, references, project binding
- [Examples](/chant/lexicons/gcp/examples/) — StorageBucket, ComputeInstance, CloudSQL, IAM
- [Lint Rules](/chant/lexicons/gcp/lint-rules/) — built-in checks for security and best practices`,
      },
      {
        slug: "config-connector-concepts",
        title: "Config Connector Concepts",
        description: "Resource structure, resourceRef, project binding, reconciliation lifecycle",
        content: `Every exported resource declaration becomes a Config Connector manifest document in the generated YAML.

## Resource structure

Every Config Connector resource has four standard fields:

| Field | Source | Example |
|-------|--------|---------|
| \`apiVersion\` | Resolved from resource type | \`storage.cnrm.cloud.google.com/v1beta1\` |
| \`kind\` | Resolved from resource type | \`StorageBucket\` |
| \`metadata\` | From \`metadata\` property | \`{ name: "my-bucket", labels: {...} }\` |
| \`spec\` | From remaining props | Resource-specific configuration |

## Resource references

Config Connector resources reference each other using \`resourceRef\`:

\`\`\`yaml
# By name (same namespace)
resourceRef:
  name: my-network

# By external reference (cross-project)
resourceRef:
  external: projects/my-project/global/networks/my-network
\`\`\`

In chant, resource references resolve automatically:

\`\`\`typescript
export const network = new ComputeNetwork({ autoCreateSubnetworks: false });

export const subnet = new ComputeSubnetwork({
  networkRef: { name: network },  // Resolves to metadata.name of network
  ipCidrRange: "10.0.0.0/24",
  region: "us-central1",
});
\`\`\`

## Project binding

Bind resources to a GCP project via annotations:

\`\`\`typescript
import { defaultAnnotations, GCP } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});
\`\`\`

This injects the project annotation into every resource. Without it, Config Connector uses the namespace's default project.

## Reconciliation lifecycle

Config Connector resources go through a reconciliation lifecycle:

| Status | Meaning |
|--------|---------|
| UpToDate | Resource matches desired state |
| Updating | Controller is applying changes |
| UpdateFailed | GCP API returned an error |
| DependencyNotReady | Waiting for a referenced resource |
| DeletionFailed | Cannot delete the GCP resource |

Check status with: \`kubectl get gcp -A\` or \`kubectl describe <resource>\`

## Default labels and annotations

Use \`defaultLabels()\` and \`defaultAnnotations()\` to inject metadata into all resources:

\`\`\`typescript
import { defaultLabels, defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const labels = defaultLabels({
  "app.kubernetes.io/managed-by": "chant",
  "env": "production",
});
\`\`\`

Explicit labels on individual resources take precedence over defaults.`,
      },
      {
        slug: "lint-rules",
        title: "Lint Rules",
        description: "Built-in lint rules and post-synth checks for GCP Config Connector manifests",
        content: `The GCP lexicon ships lint rules that run during \`chant lint\` and post-synth checks that validate the serialized YAML after \`chant build\`.

## Lint rules

Lint rules analyze your TypeScript source code before build.

| Rule | Description |
|------|-------------|
| WGC001 | Hardcoded project ID in resource constructors |
| WGC002 | Hardcoded region in resource constructors |
| WGC003 | Public IAM member (allUsers/allAuthenticatedUsers) |

## Post-synth checks

Post-synth checks run against the serialized YAML after build.

### Security

| Rule | Description |
|------|-------------|
| WGC101 | Missing encryption on StorageBucket or SQLInstance |
| WGC102 | Public IAM member detected in output |
| WGC104 | Missing uniform bucket-level access |
| WGC105 | Cloud SQL with public 0.0.0.0/0 in authorizedNetworks |
| WGC109 | ComputeFirewall allowing all sources (0.0.0.0/0) |
| WGC110 | KMS CryptoKey without rotation period |

### Best practices

| Rule | Description |
|------|-------------|
| WGC103 | Missing project annotation (uses namespace default) |
| WGC106 | Missing deletion policy annotation |
| WGC107 | StorageBucket without versioning |
| WGC108 | SQLInstance without backup configuration |
| WGC201 | Missing managed-by label |
| WGC202 | GKE cluster without workload identity |
| WGC203 | GKE node pool with overly broad cloud-platform OAuth scope |
| WGC204 | ComputeInstance without shielded VM config |

### Compliance

| Rule | Description |
|------|-------------|
| WGC301 | No IAMAuditConfig resource in output |
| WGC302 | No Service (API enablement) resource in output |
| WGC303 | No VPC Service Controls perimeter |

## Running lint

\`\`\`bash
# Lint your chant project
chant lint

# Build (also runs post-synth checks)
chant build
\`\`\`

To suppress a rule on a specific line:

\`\`\`typescript
// chant-disable-next-line WGC001
const bucket = new StorageBucket({ metadata: { annotations: { "cnrm.cloud.google.com/project-id": "my-project" } } });
\`\`\``,
      },
      {
        slug: "examples",
        title: "Examples: Resources",
        description: "GCP Config Connector resource examples — StorageBucket, ComputeInstance, CloudSQL, IAM",
        content: `## StorageBucket

A Storage bucket with encryption, versioning, and lifecycle rules:

\`\`\`typescript
import { StorageBucket, GCP } from "@intentius/chant-lexicon-gcp";

export const bucket = new StorageBucket({
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
  encryption: {
    defaultKmsKeyName: "projects/p/locations/us/keyRings/kr/cryptoKeys/key",
  },
  lifecycleRule: [
    { action: { type: "Delete" }, condition: { age: 365 } },
    { action: { type: "SetStorageClass", storageClass: "NEARLINE" }, condition: { age: 30 } },
  ],
});
\`\`\`

## ComputeInstance

A Compute Engine VM with shielded VM configuration:

\`\`\`typescript
import { ComputeInstance, GCP } from "@intentius/chant-lexicon-gcp";

export const vm = new ComputeInstance({
  machineType: "e2-medium",
  zone: "us-central1-a",
  bootDisk: {
    initializeParams: {
      sourceImageRef: {
        external: "projects/debian-cloud/global/images/debian-12",
      },
    },
  },
  networkInterface: [{
    networkRef: { name: "my-network" },
    subnetworkRef: { name: "my-subnet" },
  }],
  shieldedInstanceConfig: {
    enableSecureBoot: true,
    enableVtpm: true,
    enableIntegrityMonitoring: true,
  },
});
\`\`\`

## Cloud SQL

A PostgreSQL instance with backups and high availability:

\`\`\`typescript
import { CloudSqlInstance } from "@intentius/chant-lexicon-gcp";

const { instance, database, user } = CloudSqlInstance({
  name: "app-db",
  databaseVersion: "POSTGRES_15",
  tier: "db-custom-2-8192",
  region: "us-central1",
  backupEnabled: true,
  highAvailability: true,
  diskSize: 50,
});

export { instance, database, user };
\`\`\`

## IAM Binding

Grant a service account access to a resource:

\`\`\`typescript
import { IAMPolicyMember } from "@intentius/chant-lexicon-gcp";

export const binding = new IAMPolicyMember({
  member: "serviceAccount:app@my-project.iam.gserviceaccount.com",
  role: "roles/storage.objectViewer",
  resourceRef: {
    apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
    kind: "StorageBucket",
    name: "my-bucket",
  },
});
\`\`\``,
      },
      {
        slug: "composite-examples",
        title: "Examples: Composites",
        description: "All 10 GCP composites with full code and deployment workflow",
        content: `Composites are higher-level constructs that produce multiple coordinated Config Connector resources from a single function call.

## GkeCluster

GKE cluster with node pool and workload identity:

\`\`\`typescript
import { GkeCluster } from "@intentius/chant-lexicon-gcp";

const { cluster, nodePool } = GkeCluster({
  name: "my-cluster",
  location: "us-central1",
  machineType: "e2-standard-4",
  minNodeCount: 1,
  maxNodeCount: 10,
  workloadIdentity: true,
});

export { cluster, nodePool };
\`\`\`

## CloudRunService

Cloud Run service with optional public access:

\`\`\`typescript
import { CloudRunService } from "@intentius/chant-lexicon-gcp";

const { service, publicIam } = CloudRunService({
  name: "my-api",
  image: "gcr.io/my-project/api:1.0",
  port: 8080,
  publicAccess: true,
  minInstanceCount: 1,
  maxInstanceCount: 10,
});

export { service, publicIam };
\`\`\`

## CloudSqlInstance

PostgreSQL with database and user:

\`\`\`typescript
import { CloudSqlInstance } from "@intentius/chant-lexicon-gcp";

const { instance, database, user } = CloudSqlInstance({
  name: "app-db",
  tier: "db-custom-2-8192",
  backupEnabled: true,
  highAvailability: true,
});

export { instance, database, user };
\`\`\`

## GcsBucket

Storage bucket with encryption and lifecycle:

\`\`\`typescript
import { GcsBucket } from "@intentius/chant-lexicon-gcp";

const { bucket } = GcsBucket({
  name: "data-lake",
  location: "US",
  versioning: true,
  kmsKeyName: "projects/p/locations/us/keyRings/kr/cryptoKeys/key",
  lifecycleDeleteAfterDays: 365,
  lifecycleNearlineAfterDays: 30,
});

export { bucket };
\`\`\`

## VpcNetwork

VPC with subnets, firewalls, and Cloud NAT:

\`\`\`typescript
import { VpcNetwork } from "@intentius/chant-lexicon-gcp";

const { network, subnets, firewalls, router, routerNat } = VpcNetwork({
  name: "production",
  subnets: [
    { name: "app", ipCidrRange: "10.0.0.0/24", region: "us-central1" },
    { name: "data", ipCidrRange: "10.0.1.0/24", region: "us-central1" },
  ],
  enableNat: true,
  natRegion: "us-central1",
  allowIapSsh: true,
});

export { network, subnets, firewalls, router, routerNat };
\`\`\`

## PubSubPipeline

Topic + Subscription + optional dead-letter queue:

\`\`\`typescript
import { PubSubPipeline } from "@intentius/chant-lexicon-gcp";

const { topic, subscription, deadLetterTopic, subscriberIam } = PubSubPipeline({
  name: "order-events",
  enableDeadLetterQueue: true,
  maxDeliveryAttempts: 5,
  subscriberServiceAccount: "worker@my-project.iam.gserviceaccount.com",
});

export { topic, subscription, deadLetterTopic, subscriberIam };
\`\`\`

## CloudFunctionWithTrigger

Cloud Function + source bucket + optional public invoker IAM:

\`\`\`typescript
import { CloudFunctionWithTrigger } from "@intentius/chant-lexicon-gcp";

const { function: fn, sourceBucket, invokerIam } = CloudFunctionWithTrigger({
  name: "process-upload",
  runtime: "nodejs20",
  entryPoint: "handler",
  triggerType: "pubsub",
  triggerTopic: "file-uploads",
  region: "us-central1",
});

export { fn, sourceBucket, invokerIam };
\`\`\`

## PrivateService

Private service networking (VPC peering):

\`\`\`typescript
import { PrivateService } from "@intentius/chant-lexicon-gcp";

const { globalAddress, serviceConnection, dnsZone } = PrivateService({
  name: "db-peering",
  networkName: "production",
  enableDns: true,
});

export { globalAddress, serviceConnection, dnsZone };
\`\`\`

## ManagedCertificate

Google-managed SSL certificate + optional HTTPS proxy:

\`\`\`typescript
import { ManagedCertificate } from "@intentius/chant-lexicon-gcp";

const { certificate, targetHttpsProxy, urlMap } = ManagedCertificate({
  name: "web-cert",
  domains: ["example.com", "www.example.com"],
  createProxy: true,
  backendServiceName: "web-backend",
});

export { certificate, targetHttpsProxy, urlMap };
\`\`\`

## SecureProject

Project with audit logging, API enablement, and IAM:

\`\`\`typescript
import { SecureProject } from "@intentius/chant-lexicon-gcp";

const { project, auditConfig, services, ownerIam, loggingSink } = SecureProject({
  name: "my-project",
  orgId: "123456789",
  billingAccountRef: "ABCDEF-123456-ABCDEF",
  owner: "user:admin@example.com",
  loggingSinkDestination: "bigquery.googleapis.com/projects/audit/datasets/logs",
});

export { project, auditConfig, services, ownerIam, loggingSink };
\`\`\`

## Deploying composites

\`\`\`bash
# Build YAML manifests
chant build src/ --output manifests.yaml

# Lint for common issues
chant lint src/

# Dry run
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
\`\`\``,
      },
      {
        slug: "operational-playbook",
        title: "Operational Playbook",
        description: "Build, lint, apply, troubleshoot Config Connector resources",
        content: `This playbook covers the full lifecycle of chant-produced Config Connector manifests.

## Build & validate

| Step | Command | What it catches |
|------|---------|-----------------|
| Lint source | \`chant lint src/\` | Hardcoded project IDs (WGC001), regions (WGC002), public IAM (WGC003) |
| Build manifests | \`chant build src/ --output manifests.yaml\` | Post-synth: missing encryption (WGC101), public IAM (WGC102), missing project annotation (WGC103), 14 more checks |
| Server dry-run | \`kubectl apply -f manifests.yaml --dry-run=server\` | K8s API validation: CRD schema errors, admission webhooks |

## Deploy to Kubernetes

\`\`\`bash
# Build
chant build src/ --output manifests.yaml

# Diff before applying
kubectl diff -f manifests.yaml

# Dry run
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
\`\`\`

## Monitoring reconciliation

\`\`\`bash
# List all Config Connector resources
kubectl get gcp -A

# Check specific resource status
kubectl describe storagebuckets.storage.cnrm.cloud.google.com my-bucket

# Watch for status changes
kubectl get gcp -A -w
\`\`\`

## Troubleshooting

| Status | Meaning | Diagnostic | Fix |
|--------|---------|------------|-----|
| UpToDate | Resource in sync | None needed | — |
| Updating | Applying changes | \`kubectl describe\` → Events | Wait for completion |
| UpdateFailed | GCP API error | \`kubectl describe\` → Events | Check IAM permissions, quota, API enablement |
| DependencyNotReady | Waiting for ref | \`kubectl get gcp\` | Ensure referenced resource exists and is UpToDate |
| DeletionFailed | Cannot delete | \`kubectl describe\` → Events | Check IAM permissions, child resource dependencies |

## Common issues

| Symptom | Cause | Resolution |
|---------|-------|------------|
| Resource stuck in Updating | Missing GCP API | Enable API: add Service resource or \`gcloud services enable\` |
| Permission denied | Service account lacks IAM role | Grant role to Config Connector SA |
| Resource recreated on every apply | Missing deletion-policy annotation | Add \`cnrm.cloud.google.com/deletion-policy: abandon\` |
| Namespace not found | ConfigConnectorContext missing | Create ConfigConnectorContext in namespace |
| Cross-project reference fails | Missing project annotation | Add \`cnrm.cloud.google.com/project-id\` annotation |

## Quick reference

| Command | Description |
|---------|-------------|
| \`chant build src/\` | Synthesize manifests |
| \`chant lint src/\` | Check for anti-patterns |
| \`kubectl apply -f manifests.yaml\` | Apply to cluster |
| \`kubectl get gcp -A\` | List all Config Connector resources |
| \`kubectl describe <resource>\` | Check reconciliation status |
| \`kubectl delete -f manifests.yaml\` | Remove resources |`,
      },
      {
        slug: "importing-yaml",
        title: "Importing Existing YAML",
        description: "Convert existing Config Connector YAML into typed TypeScript",
        content: `Chant can parse existing Config Connector YAML manifests and generate typed TypeScript source files.

## How it works

\`\`\`
Input YAML → parse → generate TypeScript → export typed resources
\`\`\`

The importer reads multi-document YAML, identifies Config Connector resources by their \`cnrm.cloud.google.com\` apiVersion, and generates corresponding typed constructor calls.

## Example

Input YAML:

\`\`\`yaml
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
spec:
  location: US
  uniformBucketLevelAccess: true
\`\`\`

Generated TypeScript:

\`\`\`typescript
import { Bucket } from "@intentius/chant-lexicon-gcp";

export const myBucket = new Bucket({
  metadata: { name: "my-bucket" },
  location: "US",
  uniformBucketLevelAccess: true,
});
\`\`\`

## Limitations

The import pipeline:

- Only handles Config Connector resources (\`cnrm.cloud.google.com\` apiVersion)
- Non-CC resources (standard K8s Deployments, Services) are filtered out
- Resource references are preserved as literal values, not typed refs
- Multi-document YAML is fully supported`,
      },
      {
        slug: "skills",
        title: "AI Skills",
        description: "AI agent skills bundled with the GCP lexicon",
        content: `The GCP lexicon ships an AI skill called **chant-gcp** that teaches AI coding agents how to build, validate, and deploy Config Connector manifests from a chant project.

## What are skills?

Skills are structured markdown documents bundled with a lexicon. When an AI agent works in a chant project, it discovers and loads relevant skills automatically.

## Installation

When you scaffold a new project with \`chant init --lexicon gcp\`, the skill is installed to \`skills/chant-gcp/SKILL.md\`.

## Skill: chant-gcp

The \`chant-gcp\` skill covers:

- **Build** — \`chant build src/ --output manifests.yaml\`
- **Lint** — \`chant lint src/\` + 17 post-synth checks
- **Apply** — \`kubectl apply -f manifests.yaml\`
- **Status** — \`kubectl get gcp -A\`
- **Troubleshooting** — reconciliation status, events, common error patterns

## MCP integration

| MCP tool | Description |
|----------|-------------|
| \`diff\` | Compare current build output against previous |

| MCP resource | Description |
|--------------|-------------|
| \`resource-catalog\` | JSON list of all supported Config Connector resource types |
| \`examples/basic-bucket\` | Example StorageBucket code |`,
      },
    ],
    sidebarExtra: [
      { label: "Deploying to GKE", slug: "gke-kubernetes" },
    ],
  };

  const result = docsPipeline(config);
  writeDocsSite(config, result);

  if (opts?.verbose) {
    console.error(
      `Generated docs: ${result.stats.resources} resources, ${result.stats.properties} properties, ${result.stats.services} services, ${result.stats.rules} rules`,
    );
  }
}
