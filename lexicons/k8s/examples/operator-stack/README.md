# Operator Stack

The operating loop itself, declared as a Kubernetes estate (#1940): one Namespace, one CronJob per hosted `ConvergeOp` tick, and RBAC scoped to what each tick can actually do — a read-only observer never gets more than `get`/`list`/`watch`, and a mutating loop's `create`/`update`/`patch` grant is scoped to its own CronJob's ServiceAccount, never a blanket permission shared across the stack.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the operator-stack example to my Kubernetes cluster.
> ```

## What this produces

- **K8s** (`k8s.yaml`): 1 Namespace + 2 CronJobs + 2 ServiceAccounts + 2 Roles + 2 RoleBindings, from 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | `OperatorStack` — Namespace, CronJob × 2, ServiceAccount × 2, Role × 2, RoleBinding × 2 |

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

## Teardown

```bash
kubectl delete -f k8s.yaml
```

## Related examples

- [cronjob-cleanup](../cronjob-cleanup/) -- a single hand-declared CronJob
- [namespace-rbac](../namespace-rbac/) -- Namespace + ServiceAccount + Role + RoleBinding by hand
- [batch-workers](../batch-workers/) -- batch processing with RBAC via composites

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
