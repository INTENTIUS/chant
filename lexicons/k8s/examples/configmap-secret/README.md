# ConfigMap and Secret

A Deployment with ConfigMap and Secret for environment configuration — demonstrates config injection via `envFrom`.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the configmap-secret example to my Kubernetes cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 4 Kubernetes resources across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | ConfigMap, Secret, Deployment, Service |

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

- [basic-deployment](../basic-deployment/) — Simple Deployment with Service
- [statefulset](../statefulset/) — StatefulSet with persistent storage

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
