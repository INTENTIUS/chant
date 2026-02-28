---
skill: chant-k8s-web-platform
description: Deploy and manage the K8s web platform example
user-invocable: true
---

# K8s Web Platform Example

This project demonstrates a production web platform using K8s composites:
TLS ingress with cert-manager, Envoy sidecar proxy, network isolation,
shared EFS storage, and Prometheus monitoring patterns.

See also the lexicon skills `chant-k8s` and `chant-k8s-patterns` for
composite reference and advanced patterns.

## Project layout

- `src/namespace.ts` — Namespace for web workloads
- `src/frontend.ts` — WebApp composite (Deployment + Service + PDB)
- `src/api.ts` — SidecarApp composite (Deployment + Service with Envoy sidecar)
- `src/ingress.ts` — SecureIngress composite (Ingress with cert-manager TLS)
- `src/network.ts` — NetworkIsolatedApp composite (Deployment + Service + NetworkPolicy)
- `src/storage.ts` — EfsStorageClass composite (StorageClass for AWS EFS)
- `src/chant.config.json` — lint configuration
- `k8s.yaml` — generated K8s manifests (do not edit)

## Local verification (no cluster required)

```bash
bun run build              # generates k8s.yaml (11 K8s resources)
bun run lint               # zero errors expected
```

Run tests from the repo root:

```bash
bun test examples/k8s-web-platform/
```

## Deploy workflow

### Prerequisites

- A Kubernetes cluster with:
  - cert-manager installed (for SecureIngress TLS)
  - nginx ingress controller (for Ingress class)
  - AWS EFS CSI driver (for EfsStorageClass)
- kubectl configured

### Full deploy

```bash
bun run deploy             # build → apply → wait → status
```

### Step by step

```bash
bun run build              # generate k8s.yaml
bun run apply              # kubectl apply -f k8s.yaml
bun run wait               # wait for frontend rollout
bun run status             # check pod status
```

## Verify

```bash
bun run status             # pod listing
bun run logs               # frontend logs
kubectl get ingress -n web-platform
kubectl get networkpolicy -n web-platform
kubectl get storageclass efs-shared
```

## Teardown

```bash
bun run teardown           # kubectl delete -f k8s.yaml
```

## Troubleshooting

- Ingress not getting address → check nginx ingress controller: `kubectl get pods -n ingress-nginx`
- Certificate not issued → check cert-manager: `kubectl get certificate -n web-platform`
- NetworkPolicy blocking traffic → check policy rules: `kubectl describe networkpolicy -n web-platform`
- EFS mount failing → check EFS CSI driver: `kubectl get pods -n kube-system -l app=efs-csi-controller`
