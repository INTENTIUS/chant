---
skill: chant-eks-microservice
description: Build, deploy, and manage the EKS microservice example
user-invocable: true
---

# EKS Microservice Example

This project defines AWS EKS infrastructure (CloudFormation) and Kubernetes
workloads in TypeScript using two chant lexicons.

## Project layout

- `src/infra/` — AWS resources (VPC, EKS cluster, IAM roles, addons, parameters)
- `src/k8s/` — K8s resources (app, ingress, observability, storage, namespace)
- `src/config.ts` — cross-lexicon config (env vars populated by `just load-outputs`)
- `.env` — auto-populated ARNs from CF stack outputs (gitignored)

## Build

```bash
just build              # both CF template + K8s manifests
just build-k8s          # K8s manifests only (after .env is populated)
```

## Deploy workflow

```bash
just deploy             # full: build → deploy-infra → configure-kubectl → load-outputs → build-k8s → apply → wait → status
```

Or step by step:

```bash
just deploy-infra domain=myapp.example.com cert=arn:aws:acm:...  # CF stack
just configure-kubectl  # update kubeconfig
just load-outputs       # write .env from CF outputs
just build-k8s          # rebuild K8s with real ARNs
just apply              # kubectl apply
just wait               # rollout status
just status             # check pods, ingress, daemonsets
```

## Verify

```bash
just status
just logs               # app pod logs
```

## Teardown

```bash
just teardown           # delete K8s → wait for ALB drain → delete CF stack
```

## Troubleshooting

- ALB not provisioning → check ALB controller addon: `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller`
- Pods pending → check node group scaling: `kubectl get nodes`
- IRSA not working → verify OIDC provider thumbprint and role trust policy
- ExternalDNS not updating → check Route53 hosted zone exists and role has access
