# Pub/Sub

A Pub/Sub topic with subscription and dead-letter queue -- built using the `PubSubTopic` and `PubSubSubscription` resources.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gcp`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | GCP Config Connector lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the pubsub example to my GCP project.
> ```

## What this produces

- **GCP** (`config.yaml`): Config Connector resources across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | PubSubTopic (x2), PubSubSubscription (x2) |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/) with Config Connector enabled
- [ ] A GCP project with Config Connector installed

**Local verification** (build, lint) requires only Node.js -- no GCP account needed.

## Local verification

```bash
npx chant build src --lexicon gcp -o config.yaml
npx chant lint src
```

## Deploy

```bash
kubectl apply -f config.yaml
```

## Teardown

```bash
kubectl delete -f config.yaml
```

## Related examples

- [cloud-function](../cloud-function/) -- Cloud Function with Pub/Sub trigger
- [cloud-run](../cloud-run/) -- Cloud Run service with IAM invoker

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
