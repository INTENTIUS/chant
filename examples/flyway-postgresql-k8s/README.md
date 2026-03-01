# Flyway + PostgreSQL on Kubernetes

Deploy PostgreSQL as a Kubernetes StatefulSet on a local k3d cluster, then run Flyway database migrations against it — all defined in a single TypeScript file.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon k8s` and `chant init --lexicon flyway`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes manifest lifecycle: build, lint, apply, rollback, troubleshooting |
| `chant-flyway` | `@intentius/chant-lexicon-flyway` | Flyway migration lifecycle: build, validate, migrate, repair |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the flyway-postgresql-k8s example locally.
> ```

## What this produces

- **K8s** (`k8s.yaml`): Namespace, Secret, StatefulSet, headless Service, NodePort Service (5 resources)
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

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [Docker](https://docs.docker.com/get-docker/)
- [ ] [k3d](https://k3d.io/) (lightweight k3s in Docker)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [ ] [Flyway CLI](https://documentation.red-gate.com/flyway/flyway-cli-and-api/download-and-installation)

**Local verification** (build, lint, test) requires only Node.js — no cluster or Docker needed.

## Local verification

```bash
npx chant build src --lexicon k8s -o k8s.yaml
npx chant build src --lexicon flyway -o flyway.toml
npx chant lint src
```

## Deploy

### Step by step

1. **Create a k3d cluster** — port 30432 is mapped from the host so Flyway can reach PostgreSQL without `kubectl port-forward`:

   ```bash
   k3d cluster create flyway-pg -p '30432:30432@server:0' --wait
   ```

2. **Build** — generates `k8s.yaml` (K8s manifests) and `flyway.toml` (Flyway config):

   ```bash
   npx chant build src --lexicon k8s -o k8s.yaml
   npx chant build src --lexicon flyway -o flyway.toml
   ```

3. **Deploy PostgreSQL** — applies K8s manifests and waits for the StatefulSet:

   ```bash
   kubectl apply -f k8s.yaml
   kubectl -n flyway-pg rollout status statefulset/postgres --timeout=120s
   ```

4. **Run migrations** — executes V1–V3 against the database via the NodePort:

   ```bash
   flyway migrate -environment=local
   ```

## Verify

```bash
flyway info -environment=local                  # Flyway migration history
kubectl get pods -n flyway-pg                   # Pod status
kubectl get svc -n flyway-pg                    # Services (headless + NodePort)
kubectl -n flyway-pg exec -it postgres-0 -- psql -U postgres -d app -c '\dt'  # Tables
```

## Teardown

```bash
k3d cluster delete flyway-pg
```

Deletes the k3d cluster and all resources.

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — Production-grade AWS EKS + K8s cross-lexicon
- [flyway-postgresql-gitlab-aws-rds](../flyway-postgresql-gitlab-aws-rds/) — AWS RDS + Flyway + GitLab CI
- [k8s-batch-workers](../k8s-batch-workers/) — Background processing platform with K8s composites
