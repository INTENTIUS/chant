# Basic Deployment

A Kubernetes Deployment with a Service — the simplest K8s example demonstrating health checks and port mapping.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the basic-deployment example to my Kubernetes cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 2 Kubernetes resources across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | Deployment, Service |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster

**Local verification** (build, lint) requires only Node.js — no cluster needed.

## Local verification

```bash
npx chant build src --lexicon k8s -o k8s.yaml
npx chant lint src
```

## Deploy

```bash
kubectl apply -f k8s.yaml
```

## Teardown

```bash
kubectl delete -f k8s.yaml
```

## Related examples

- [configmap-secret](../configmap-secret/) — ConfigMaps, Secrets, and environment injection
- [statefulset](../statefulset/) — StatefulSet with persistent storage
