---
source: chant-lexicon
lexicon: gcp
---

# GCP Security Best Practices for Chant

## Overview

Security patterns and best practices for GCP Config Connector manifests generated with chant.
These patterns map directly to the post-synth checks (WGC101–WGC303) and help AI agents
produce secure-by-default infrastructure.

## Encryption

### CMEK via Cloud KMS

Use customer-managed encryption keys (CMEK) for StorageBucket and other resources:

```ts
import { StorageBucket, KMSCryptoKey, KMSKeyRing } from "@intentius/chant-lexicon-gcp";

export const keyRing = new KMSKeyRing({
  location: "us-central1",
});

export const cryptoKey = new KMSCryptoKey({
  keyRingRef: { name: keyRing },
  purpose: "ENCRYPT_DECRYPT",
  rotationPeriod: "7776000s",
});

export const bucket = new StorageBucket({
  location: "US",
  encryption: {
    defaultKmsKeyName: cryptoKey,
  },
});
```

### SQLInstance Encryption and Backup

Always configure backup and encryption on Cloud SQL instances:

```ts
export const db = new SQLInstance({
  databaseVersion: "POSTGRES_15",
  settings: {
    tier: "db-custom-2-8192",
    backupConfiguration: {
      enabled: true,
      pointInTimeRecoveryEnabled: true,
    },
    ipConfiguration: {
      requireSsl: true,
    },
  },
});
```

### KMS Key Rotation

Always set a rotation period on KMS encryption keys:

```ts
export const key = new KMSCryptoKey({
  keyRingRef: { name: keyRing },
  purpose: "ENCRYPT_DECRYPT",
  rotationPeriod: "7776000s", // 90 days
});
```

## IAM

### Workload Identity

Enable Workload Identity on GKE clusters instead of using node service account keys:

```ts
export const cluster = new GKECluster({
  location: GCP.Region,
  workloadIdentityConfig: {
    workloadPool: "PROJECT_ID.svc.id.goog",
  },
});
```

### Least-Privilege Roles

Use specific predefined roles instead of overly broad roles:

```ts
// Good: specific role
export const binding = new IAMPolicyMember({
  member: "serviceAccount:my-sa@PROJECT.iam.gserviceaccount.com",
  role: "roles/storage.objectViewer",
  resourceRef: { name: bucket },
});

// Bad: overly broad
// role: "roles/editor"
```

### No Service Account Keys

Avoid creating service account keys — use Workload Identity or federated identity instead.

### Avoid Public IAM Bindings

Never use `allUsers` or `allAuthenticatedUsers` as IAM members unless intentional:

```ts
// Bad — flagged by WGC102
export const publicAccess = new IAMPolicyMember({
  member: "allUsers",
  role: "roles/run.invoker",
});
```

## Network Security

### VPC Service Controls

Use AccessContextManager service perimeters to protect sensitive resources:

```ts
import { AccessContextManagerServicePerimeter } from "@intentius/chant-lexicon-gcp";

export const perimeter = new AccessContextManagerServicePerimeter({
  title: "my-perimeter",
  perimeterType: "PERIMETER_TYPE_REGULAR",
  status: {
    restrictedServices: [
      "storage.googleapis.com",
      "bigquery.googleapis.com",
    ],
  },
});
```

### Private Cloud SQL

Never allow `0.0.0.0/0` in Cloud SQL authorized networks:

```ts
// Good: private access only
export const db = new SQLInstance({
  settings: {
    ipConfiguration: {
      ipv4Enabled: false,
      privateNetworkRef: { name: myVpc },
    },
  },
});
```

### Firewall Rules

Avoid overly permissive source ranges in firewall rules:

```ts
// Bad — flagged by WGC109
export const firewall = new ComputeFirewall({
  sourceRanges: ["0.0.0.0/0"],
  allowed: [{ protocol: "tcp", ports: ["22"] }],
});

// Good: specific CIDR
export const firewall = new ComputeFirewall({
  sourceRanges: ["10.0.0.0/8"],
  allowed: [{ protocol: "tcp", ports: ["22"] }],
});
```

## Audit & Logging

### IAMAuditConfig

Enable data access audit logging:

```ts
import { IAMAuditConfig } from "@intentius/chant-lexicon-gcp";

export const auditConfig = new IAMAuditConfig({
  service: "allServices",
  auditLogConfigs: [
    { logType: "ADMIN_READ" },
    { logType: "DATA_READ" },
    { logType: "DATA_WRITE" },
  ],
});
```

## Other Best Practices

### Deletion Policy

Set deletion policies on stateful resources to prevent accidental deletion:

```ts
// Use the annotation on metadata
metadata:
  annotations:
    cnrm.cloud.google.com/deletion-policy: abandon
```

Or use `defaultAnnotations`:

```ts
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/deletion-policy": "abandon",
});
```

### Shielded VMs

Enable shielded VM features on ComputeInstance:

```ts
export const vm = new ComputeInstance({
  machineType: "e2-medium",
  zone: "us-central1-a",
  shieldedInstanceConfig: {
    enableSecureBoot: true,
    enableVtpm: true,
    enableIntegrityMonitoring: true,
  },
});
```

### Uniform Bucket-Level Access

Enable uniform bucket-level access on storage buckets:

```ts
export const bucket = new StorageBucket({
  location: "US",
  uniformBucketLevelAccess: true,
});
```

### Object Versioning

Enable versioning on storage buckets for data protection:

```ts
export const bucket = new StorageBucket({
  location: "US",
  versioning: { enabled: true },
});
```

## Post-Synth Check Reference

| Check | Severity | Description |
|-------|----------|-------------|
| WGC101 | warning | StorageBucket or SQLInstance without encryption |
| WGC102 | warning | Public IAM binding (allUsers/allAuthenticatedUsers) in output |
| WGC103 | warning | Missing `cnrm.cloud.google.com/project-id` annotation |
| WGC104 | warning | StorageBucket without uniformBucketLevelAccess |
| WGC105 | warning | SQLInstance with 0.0.0.0/0 in authorizedNetworks |
| WGC106 | info | Missing deletion policy annotation |
| WGC107 | warning | StorageBucket without versioning |
| WGC108 | warning | SQLInstance without backup configuration |
| WGC109 | warning | ComputeFirewall with 0.0.0.0/0 source range |
| WGC110 | warning | KMSCryptoKey without rotation period |
| WGC111 | warning | Dangling resourceRef (referenced name not in output) |
| WGC112 | error | Missing or invalid apiVersion |
| WGC113 | warning | Alpha API version (prefer v1beta1 or v1) |
| WGC201 | info | Missing managed-by label |
| WGC202 | warning | GKE cluster without Workload Identity |
| WGC203 | warning | Overly broad OAuth scope (cloud-platform) |
| WGC204 | warning | ComputeInstance without shielded VM config |
| WGC301 | info | No IAMAuditConfig in output |
| WGC302 | info | No Service resource (API enablement) in output |
| WGC303 | info | Missing VPC Service Controls |
