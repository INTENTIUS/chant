---
skill: chant-gcp
description: Build, validate, and deploy GCP Config Connector manifests from a chant project
source: chant-lexicon
user-invocable: true
---

# GCP Config Connector Operational Playbook

## How chant and Config Connector relate

chant is a **synthesis-only** tool — it compiles TypeScript source files into Config Connector YAML manifests. chant does NOT call GCP APIs. Your job as an agent is to bridge the two:

- Use **chant** for: build, lint, diff (local YAML comparison)
- Use **kubectl** for: apply, rollback, monitoring, troubleshooting

The source of truth for infrastructure is the TypeScript in `src/`. The generated YAML manifests are intermediate artifacts.

## Prerequisites

1. A GKE cluster with Config Connector installed
2. A ConfigConnectorContext resource per namespace
3. A GCP Service Account with appropriate IAM roles

## Build and validate

### Build manifests

```bash
chant build src/ --output manifests.yaml
```

### Lint the source

```bash
chant lint src/
```

### What each step catches

| Step | Catches | When to run |
|------|---------|-------------|
| `chant lint` | Hardcoded project IDs (WGC001), regions (WGC002), public IAM (WGC003) | Every edit |
| `chant build` | Post-synth: missing encryption (WGC101), public IAM in output (WGC102), missing project annotation (WGC103) | Before apply |

## Applying to Kubernetes

```bash
# Build
chant build src/ --output manifests.yaml

# Dry run
kubectl apply -f manifests.yaml --dry-run=server

# Apply
kubectl apply -f manifests.yaml
```

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

## Troubleshooting

| Status | Meaning | Fix |
|--------|---------|-----|
| UpToDate | Resource is in sync | None needed |
| UpdateFailed | GCP API error | Check `kubectl describe` events |
| DependencyNotReady | Waiting for referenced resource | Ensure dependency exists |
| DeletionFailed | Cannot delete GCP resource | Check IAM permissions |

## Quick reference

| Command | Description |
|---------|-------------|
| `chant build src/` | Synthesize manifests |
| `chant lint src/` | Check for anti-patterns |
| `kubectl apply -f manifests.yaml` | Apply to cluster |
| `kubectl get gcp` | List all Config Connector resources |
| `kubectl describe <resource>` | Check reconciliation status |
