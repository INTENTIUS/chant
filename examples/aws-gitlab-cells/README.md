# Cell-Based Architecture on EKS with GitLab CI

A multi-tenant Kubernetes deployment using the AWS Well-Architected [cell-based architecture](https://docs.aws.amazon.com/wellarchitected/latest/reducing-scope-of-impact-with-cell-based-architecture/reducing-scope-of-impact-with-cell-based-architecture.html) pattern. Three chant lexicons in one project: **AWS** (EKS cluster), **K8s** (workloads), **GitLab** (pipeline).

Inspired by [GitLab's Cells architecture](https://handbook.gitlab.com/handbook/engineering/architecture/design-documents/cells/) — each cell is an isolated unit sharing a control plane but keeping tenant workloads separated via namespace boundaries, network policies, resource quotas, and IRSA-scoped IAM roles.

## Skills

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | AWS CloudFormation lifecycle |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes workload lifecycle |
| `chant-gitlab` | `@intentius/chant-lexicon-gitlab` | GitLab CI pipeline generation |

> **Using Claude Code?** Just ask:
>
> ```
> Build and lint the aws-gitlab-cells example.
> ```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  AWS (CloudFormation)                                        │
│                                                              │
│  KmsKey (envelope encryption + EBS)    ECR (scan-on-push)    │
│  OIDCProvider (IRSA federation)                              │
│                                                              │
│  VPC (3-AZ, explicit subnets + route tables + NAT)           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  EKSCluster                                            │  │
│  │  SecurityGroup (control plane) ──┐                     │  │
│  │                                  │                     │  │
│  │  Nodegroup + LaunchTemplate      │ (encrypted EBS,     │  │
│  │  SecurityGroup (nodes) ──────────┘  multi-AZ)          │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │  system namespace (shared control plane)         │  │  │
│  │  │  - ingress-nginx controller                      │  │  │
│  │  │  - prometheus + grafana                          │  │  │
│  │  │  - cert-manager                                  │  │  │
│  │  │  - cluster-autoscaler (IRSA service account)     │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │                                                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐              │  │
│  │  │  cell-alpha      │  │  cell-beta      │  ...        │  │
│  │  │  - namespace     │  │  - namespace    │             │  │
│  │  │  - netpol (deny) │  │  - netpol (deny)│             │  │
│  │  │  - quotas        │  │  - quotas       │             │  │
│  │  │  - SA (IRSA)     │  │  - SA (IRSA)    │             │  │
│  │  │  - deployment    │  │  - deployment   │             │  │
│  │  │  - HPA           │  │  - HPA          │             │  │
│  │  │  - PDB           │  │  - PDB          │             │  │
│  │  │  - service       │  │  - service      │             │  │
│  │  │  - ingress       │  │  - ingress      │             │  │
│  │  └─────────────────┘  └─────────────────┘              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## Cell-based isolation

Each cell is a fully isolated tenant boundary:

- **Network isolation** — default-deny `NetworkPolicy` per cell namespace. Only the system namespace ingress controller can reach cell pods. Cells cannot communicate with each other.
- **Resource isolation** — `ResourceQuota` and `LimitRange` per cell cap CPU, memory, and pod count.
- **IAM isolation** — IRSA gives each cell's service account a scoped IAM role. No shared node-level credentials.
- **Blast radius reduction** — a failure in one cell (OOM, crash loop, resource exhaustion) cannot affect other cells or the system namespace.

## Config-driven fan-out

A single array in `src/config.ts` drives everything:

```ts
export const cells = [
  { name: "alpha", replicas: 3, maxReplicas: 10, cpuQuota: "4", ... },
  { name: "beta",  replicas: 2, maxReplicas: 6,  cpuQuota: "2", ... },
];
```

Adding a cell means adding one entry. All K8s resources (namespace, quota, network policy, deployment, HPA, PDB, service, ingress) and the GitLab CI matrix job are derived from this array.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) >= 2.x
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [jq](https://jqlang.github.io/jq/download/)

## Local verification (no AWS required)

```bash
cp .env.example .env
npm install
npm run build
npm run lint
```

## Deploy

```bash
npm run deploy
```

This runs:
1. **Build** — generates CloudFormation, K8s manifests, and GitLab CI pipeline
2. **Deploy infra** — creates 30+ CF resources (VPC, EKS, KMS, IAM, ECR)
3. **Configure kubectl** — sets up kubeconfig
4. **Load outputs** — populates `.env` with real ARNs from stack outputs
5. **Rebuild K8s** — regenerates manifests with real IRSA role ARNs
6. **Apply** — deploys system namespace first, then cell namespaces

## Pipeline stages

The generated `.gitlab-ci.yml` has 4 stages:

```
infra (CloudFormation deploy)
  └─→ system (kubectl apply system/)
       └─→ validate (kubectl diff — dry-run preview)
            └─→ cells (parallel:matrix)
                 ├─ deploy-cell [alpha]
                 └─ deploy-cell [beta]
```

## Well-Architected alignment

| Pillar | Implementation |
|--------|---------------|
| **Security** | KMS envelope encryption, explicit SecurityGroups, IRSA per-cell, default-deny NetworkPolicy, ECR scan-on-push |
| **Reliability** | 3-AZ node group, PodDisruptionBudget per cell, liveness/readiness probes, topology spread constraints |
| **Operational Excellence** | `kubectl diff` dry-run stage, Prometheus + Grafana observability, ordered pipeline stages |
| **Performance Efficiency** | HPA per cell (CPU target from config), Cluster Autoscaler (IRSA), gp3 encrypted EBS |

## Outputs

| Output | Lexicon | Contents |
|--------|---------|----------|
| `templates/template.json` | AWS | 35 resources: EKS cluster (3-AZ, OIDC), VPC, KMS, SGs, IAM (IRSA), ECR |
| `k8s.yaml` | K8s | 35 resources: system namespace + per-cell namespaces with full workload stack |
| `.gitlab-ci.yml` | GitLab | 4-stage pipeline with matrix fan-out |

## Source files

### AWS infrastructure (`src/aws/`)

| File | Description |
|------|-------------|
| `encryption.ts` | KMS key + alias for EKS envelope encryption and EBS volumes |
| `networking.ts` | VpcDefault (3-AZ) + SecurityGroups for control plane and nodes |
| `cluster.ts` | EKS cluster, OIDC provider, managed node group, launch template |
| `iam.ts` | Cluster role, node role, IRSA factory, per-cell roles, autoscaler role |
| `ecr.ts` | ECR repository with scan-on-push |
| `outputs.ts` | Stack outputs: cluster endpoint, OIDC ARN, KMS ARN |

### System namespace (`src/system/`)

| File | Description |
|------|-------------|
| `namespace.ts` | System namespace with resource quotas via NamespaceEnv |
| `ingress-controller.ts` | NGINX ingress controller deployment + service |
| `monitoring.ts` | Prometheus + Grafana for cluster observability |
| `cert-manager.ts` | TLS certificate management |
| `cluster-autoscaler.ts` | Cluster autoscaler with IRSA service account |

### Cell resources (`src/cell/`)

| File | Description |
|------|-------------|
| `index.ts` | Config-driven cell factory — iterates cells array, creates all per-cell K8s resources using NamespaceEnv, AutoscaledService, IrsaServiceAccount composites |

### Pipeline (`src/pipeline/`)

| File | Description |
|------|-------------|
| `index.ts` | 4-stage GitLab CI pipeline with parallel:matrix cell fan-out |

## Teardown

```bash
npm run teardown
```

## Related examples

- [k8s-eks-microservice](../k8s-eks-microservice/) — single-tenant EKS deployment (AWS + K8s)
- [cockroachdb-multi-cloud](../cockroachdb-multi-cloud/) — multi-cloud K8s (AWS + Azure + GCP + K8s)
- [gitlab-aws-alb-infra](../gitlab-aws-alb-infra/) — AWS + GitLab cross-lexicon
