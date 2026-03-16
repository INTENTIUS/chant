# VPC Network

A VPC network with subnets, firewall rules, and Cloud NAT — built using the `VpcNetwork` composite.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `chant init --lexicon gcp`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | GCP Config Connector lifecycle: build, lint, deploy, rollback, troubleshooting |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the vpc-network example to my GCP project.
> ```

## Spell

This example has a corresponding spell for AI-driven deployment:

```bash
chant spell cast gcp-vpc-network
```

## What this produces

- **GCP** (`config.yaml`): Config Connector resources across 1 source file

## Source files

| File | Composite | Resources |
|------|-----------|-----------|
| `src/infra.ts` | `VpcNetwork` | ComputeNetwork, ComputeSubnetwork, ComputeFirewall, ComputeRouter, ComputeRouterNAT |

## Prerequisites

- [ ] [Node.js](https://nodejs.org/) >= 22 (Bun also works)
- [ ] [kubectl](https://kubernetes.io/docs/tasks/tools/) with Config Connector enabled
- [ ] A GCP project with Config Connector installed

**Local verification** (build, lint) requires only Node.js — no GCP account needed.

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

- [basic-bucket](../basic-bucket/) — GCS bucket with versioning and lifecycle rules
- [gke-cluster](../gke-cluster/) — GKE cluster with node pool and workload identity

## Standalone Usage

To run this example outside the monorepo:

1. Copy this directory
2. `mv package.standalone.json package.json`
3. `npm install`
4. `npm run build`
