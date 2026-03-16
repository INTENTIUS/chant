# Cloud Run

A Cloud Run service with IAM policy member for public invocation -- built using the `CloudRunService` and `IAMPolicyMember` resources.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gcp`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | GCP Config Connector lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the cloud-run example to my GCP project.
> ```

## What this produces

- **GCP** (`config.yaml`): Config Connector resources across 1 source file

## Source files

| File | Resources |
|------|-----------|
| `src/infra.ts` | CloudRunService, IAMPolicyMember |

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

- [basic-bucket](../basic-bucket/) -- GCS bucket with versioning and lifecycle rules
- [cloud-function](../cloud-function/) -- Cloud Function with Pub/Sub trigger

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
