# Flyway + PostgreSQL on Kubernetes

Deploy PostgreSQL as a Kubernetes StatefulSet on a local k3d cluster, then run Flyway database migrations against it — all defined in a single TypeScript file.

## Skills

This example includes skills for agent-guided deployment:

| Skill | Purpose |
|-------|---------|
| `chant-flyway-k8s` | Guides the full deploy → migrate → verify → teardown workflow for this example |
| `chant-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-flyway` | Flyway migration lifecycle: build, validate, migrate, repair |

> **Using Claude Code?** The skills in `.claude/skills/` guide your agent
> through the full deploy → verify → teardown workflow. Just ask:
>
> ```
> Deploy the flyway-postgresql-k8s example locally.
> ```

## What this produces

- **K8s** (`k8s.yaml`): Namespace, StatefulSet, headless Service, NodePort Service (4 resources)
- **Flyway** (`flyway.toml`): Project config with local environment pointing to PostgreSQL via NodePort

## Source files

| File | Lexicon | Purpose |
|------|---------|---------|
| `src/infra.ts` | K8s + Flyway | All resources in a single cross-lexicon file |
| `sql/migrations/V1__Create_users_table.sql` | — | Creates `users` table |
| `sql/migrations/V2__Add_email_column.sql` | — | Adds `email` column to `users` |
| `sql/migrations/V3__Create_orders_table.sql` | — | Creates `orders` table with FK to `users` |

## How cross-lexicon build works

The `src/infra.ts` file imports resources from both `@intentius/chant-lexicon-k8s` and `@intentius/chant-lexicon-flyway`. Each resource carries its lexicon namespace internally. When you run `chant build src --lexicon k8s`, only K8s resources are serialized — Flyway resources are silently skipped, and vice versa.

## Prerequisites

- [ ] [Bun](https://bun.sh)
- [ ] [Docker](https://docs.docker.com/get-docker/)
- [ ] [k3d](https://k3d.io/) (lightweight k3s in Docker)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] [Flyway CLI](https://documentation.red-gate.com/flyway/flyway-cli-and-api/download-and-installation)

**Local verification** (build, lint, test) requires only Bun — no cluster or Docker needed.

## Local verification

```bash
bun run build
bun run lint
```

## Deploy

### Automated (one command)

```bash
bun run run
```

This runs the full workflow: create cluster → build → deploy PostgreSQL → wait for readiness → run migrations.

### Step by step

1. **Create a k3d cluster** — port 30432 is mapped from the host so Flyway can reach PostgreSQL without `kubectl port-forward`:

   ```bash
   bun run cluster-create
   ```

2. **Build** — generates `k8s.yaml` (K8s manifests) and `flyway.toml` (Flyway config):

   ```bash
   bun run build
   ```

3. **Deploy PostgreSQL** — applies K8s manifests and waits for the StatefulSet:

   ```bash
   bun run apply
   bun run wait
   ```

4. **Run migrations** — executes V1–V3 against the database via the NodePort:

   ```bash
   bun run migrate
   ```

## Verify

```bash
bun run info                                    # Flyway migration history
kubectl get pods -n flyway-pg                   # Pod status
kubectl get svc -n flyway-pg                    # Services (headless + NodePort)
kubectl -n flyway-pg exec -it postgres-0 -- psql -U postgres -d app -c '\dt'  # Tables
```

## Teardown

```bash
bun run teardown
```

Deletes the k3d cluster and all resources.

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-gitlab-aws-rds](../flyway-postgresql-gitlab-aws-rds/) — AWS RDS + Flyway + GitLab CI
- [k8s-batch-workers](../k8s-batch-workers/) — Background processing platform with K8s composites
