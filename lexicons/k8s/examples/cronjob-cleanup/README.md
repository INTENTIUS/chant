# CronJob Cleanup

A Kubernetes CronJob that runs every hour to clean up temporary files -- demonstrates scheduled workloads with security hardening.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the cronjob-cleanup example to my Kubernetes cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 1 Kubernetes resource across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | CronJob |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] A Kubernetes cluster

**Local verification** (build, lint) requires only Node.js -- no cluster needed.

## Local verification

```bash
npx chant build src --lexicon k8s -o k8s.yaml
npx chant lint src
```

## Deploy

```bash
kubectl apply -f k8s.yaml
```

## Verify

```bash
kubectl get cronjob temp-cleanup
kubectl get jobs --selector=app.kubernetes.io/name=temp-cleanup
```

## Teardown

```bash
kubectl delete -f k8s.yaml
```

## Related examples

- [batch-workers](../batch-workers/) -- Batch processing with CronWorkload composite and RBAC
- [basic-deployment](../basic-deployment/) -- Deployment with a Service

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
