# StatefulSet

A PostgreSQL StatefulSet with headless Service and persistent volume claims — demonstrates stateful workloads.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the statefulset example to my Kubernetes cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 3 Kubernetes resources across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | PersistentVolumeClaim, Service (headless), StatefulSet |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster with a default StorageClass

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

- [basic-deployment](../basic-deployment/) — Simple Deployment with Service
- [configmap-secret](../configmap-secret/) — ConfigMaps, Secrets, and environment injection
