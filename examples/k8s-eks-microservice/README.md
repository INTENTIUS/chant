# EKS Microservice — Cross-Lexicon Example

A production-grade cross-lexicon example that defines both **AWS EKS infrastructure** (CloudFormation via the AWS lexicon) and **Kubernetes workloads** (YAML via the K8s lexicon) — all in TypeScript.

This demonstrates chant's multi-lexicon capability: a single `src/` directory imports from both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-k8s`, and builds to two separate outputs.

## Quick start

This example is designed to be deployed with an AI agent (e.g. Claude Code) using chant's built-in skills. The `chant-eks` skill guides your agent through the full workflow.

### Prerequisites

**Local verification** (build, lint, test) requires only **Bun** — no AWS account needed.

**AWS deployment** additionally requires:
- **AWS CLI** >= 2.x configured with EKS permissions
- **kubectl** installed
- **jq** installed (for `just load-outputs`)
- **Registered domain** (any registrar) — after the first deploy, you'll update NS records at your registrar, then create the ACM certificate. The default `api.eks-microservice-demo.dev` works for building, testing, and deploying infrastructure (K8s workloads deploy without TLS; add the cert later via `just deploy-cert`).

### Local verification (no AWS required)

Ask your agent to build, lint, and test the example:

```
Build and lint the k8s-eks-microservice example, then run its tests.
```

This runs `just build` (generates `templates/infra.json` + `k8s.yaml`), `just lint`, and `bun test examples/k8s-eks-microservice/` — all locally, no AWS account needed.

### Deploy to AWS

Ask your agent to deploy, passing your domain:

```
Deploy the k8s-eks-microservice example to AWS. My domain is myapp.example.com.
```

Your agent will use the `chant-eks` skill to walk through:

1. **Build** — `just build` generates both CloudFormation and K8s outputs
2. **Deploy infrastructure** — `just deploy-infra domain=myapp.example.com` creates 34 CF resources (VPC, EKS cluster, node group, IAM roles, add-ons, Route53 hosted zone)
3. **Configure kubectl** — `just configure-kubectl` sets up kubeconfig
4. **Load outputs** — `just load-outputs` populates `.env` with real ARNs from stack outputs, and prints Route53 nameservers for NS delegation
5. **NS delegation** — update your domain registrar's NS records to the Route53 nameservers shown in the output
6. **Deploy certificate** — `just deploy-cert` requests an ACM certificate, creates the DNS validation CNAME in Route53, and waits for validation
7. **Deploy workloads** — `just load-outputs && just build-k8s && just apply` deploys 36 K8s resources (re-run `load-outputs` to pick up the cert ARN)
8. **Verify** — `just status` checks pods, ingress, daemonsets

Or run phases 1-4 at once: `just deploy domain=myapp.example.com` (then do steps 5-8 manually after NS delegation).

The deploy is two-phase because ACM certificate DNS validation requires the Route53 hosted zone's NS records to be delegated at your registrar first. Without delegation, the validation CNAME can't be resolved and the certificate stays in PENDING_VALIDATION indefinitely.

### Cleanup

```
Tear down the k8s-eks-microservice stack.
```

Your agent runs `just teardown` — deletes K8s resources first, waits for ALB drain, then deletes the CloudFormation stack. **Delete order matters** — if the CF stack is deleted first, the ALB controller addon can't clean up the ALB.

## Skills guide

Chant provides four skills that guide your agent through every aspect of this example.

### `chant-eks` — primary entry point

The **`chant-eks`** skill (AWS lexicon) covers the full end-to-end workflow:

- Provisioning AWS infrastructure (VPC, EKS, IAM, OIDC, add-ons)
- Deploying K8s workloads with real ARNs from CF outputs
- Cross-lexicon value mapping: which CF output feeds which K8s composite prop
- Scaffolding new projects with `chant init --lexicon aws --template eks`

### `chant-k8s-eks` — EKS-specific composites

Covers the composites used in `src/k8s/`:

| Composite | File | What it does |
|-----------|------|--------------|
| `IrsaServiceAccount` | `app.ts` | IRSA setup, `eks.amazonaws.com/role-arn` annotation |
| `AlbIngress` | `ingress.ts` | ALB Controller annotations, SSL redirect, shared ALB groups |
| `EbsStorageClass` | `storage.ts` | EBS CSI provisioner, gp3 vs gp2, encryption |
| `FluentBitAgent` | `observability.ts` | DaemonSet config, CloudWatch output plugin |
| `AdotCollector` | `observability.ts` | DaemonSet config, CloudWatch metrics pipeline |
| `ExternalDnsAgent` | `ingress.ts` | Route53 integration, domain filters, IRSA |

### `chant-k8s` — core composites reference

Comprehensive reference for all 20 composites:

- **"Choosing the Right Composite" decision tree** — which composite for each workload type
- Hardening options: `minAvailable` (PDB), `initContainers`, `securityContext`, `priorityClassName`
- Build/lint/apply workflow and troubleshooting

### `chant-k8s-patterns` — advanced patterns

Patterns to add next:

- **Sidecars** — Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — `ConfiguredApp` for ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — `SecureIngress` for non-AWS ingress controllers
- **Prometheus monitoring** — `MonitoredService` with ServiceMonitor and alert rules

### Skill workflow

```
1. chant-eks          "Deploy an EKS project end-to-end"
   │                  → Scaffold, provision infra, deploy workloads
   │
2. chant-k8s-eks      "Which EKS composites do I need?"
   │                  → IRSA, ALB, EBS, FluentBit, ADOT, ExternalDNS
   │
3. chant-k8s          "How do I choose between composites?"
   │                  → Decision tree, hardening options, troubleshooting
   │
4. chant-k8s-patterns "What patterns can I add next?"
                      → Sidecars, monitoring, TLS, network isolation
```

## Source files

### AWS infrastructure (`src/infra/`)

| File | Description |
|------|-------------|
| `networking.ts` | VPC with public/private subnets, IGW, NAT gateway |
| `cluster.ts` | EKS cluster, managed node group, OIDC provider, IAM roles (cluster, node, app IRSA, ALB controller, ExternalDNS, FluentBit, ADOT) |
| `addons.ts` | EKS add-ons: vpc-cni, aws-ebs-csi-driver, coredns, kube-proxy |
| `dns.ts` | Route53 hosted zone (ACM certificate created separately via `just deploy-cert`) |
| `params.ts` | CloudFormation parameters: environment, domainName, publicAccessCidr |

### K8s workloads (`src/k8s/`)

| File | Composites Used | Description |
|------|-----------------|-------------|
| `namespace.ts` | `NamespaceEnv` | Namespace with resource quotas, limit ranges, default-deny NetworkPolicy |
| `app.ts` | `AutoscaledService`, `IrsaServiceAccount` | App Deployment + Service + HPA + PDB + IRSA ServiceAccount + ConfigMap |
| `ingress.ts` | `AlbIngress`, `ExternalDnsAgent` | ALB Ingress with TLS + ExternalDNS for Route53 |
| `storage.ts` | `EbsStorageClass` | gp3 encrypted StorageClass |
| `observability.ts` | `FluentBitAgent`, `AdotCollector` | Fluent Bit DaemonSet for CloudWatch logging + ADOT DaemonSet for CloudWatch metrics |

### Cross-lexicon config

| File | Description |
|------|-------------|
| `config.ts` | Shared config — reads env vars from `.env` (populated by `just load-outputs`), falls back to placeholder defaults |

## Architecture

```
┌─────────────────────────────────────┐
│  AWS Lexicon (CloudFormation)       │
│  ┌──────────┐  ┌──────────────┐    │
│  │ VPC/Nets │  │ EKS Cluster  │    │
│  └──────────┘  └──────┬───────┘    │
│  ┌──────────┐         │            │
│  │ IAM Roles│ ←── OIDC Provider    │
│  └────┬─────┘                      │
│  ┌────┴─────────────────────┐      │
│  │ Add-ons: vpc-cni, ebs,  │      │
│  │ coredns, kube-proxy     │      │
│  └──────────────────────────┘      │
└───────┼─────────────────────────────┘
        │ ARNs flow down via .env
┌───────▼─────────────────────────────┐
│  K8s Lexicon (kubectl apply)        │
│  ┌────────────┐  ┌──────────────┐  │
│  │ Namespace  │  │ IRSA SA      │  │
│  │ + Quotas   │  │ (role-arn)   │  │
│  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌──────────────┐  │
│  │ Autoscaled │  │ ALB Ingress  │  │
│  │ Service    │  │ (cert-arn)   │  │
│  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌──────────────┐  │
│  │ EBS Storage│  │ FluentBit    │  │
│  │ Class      │  │ Agent        │  │
│  └────────────┘  └──────────────┘  │
│  ┌────────────┐  ┌──────────────┐  │
│  │ ADOT       │  │ Metrics      │  │
│  │ Collector  │  │ Server       │  │
│  └────────────┘  └──────────────┘  │
└─────────────────────────────────────┘
```

## Resource counts

- **34 CloudFormation resources**: 17 VPC + 1 cluster + 1 nodegroup + 1 OIDC + 8 IAM roles + 4 addons + 1 KMS key + 1 Route53 hosted zone
- **36 Kubernetes resources**: across 5 source files (namespace, app, ingress, storage, observability)

## Cross-lexicon value flow

CloudFormation stack outputs map to K8s composite props via `.env`:

| CF Output | K8s File | Composite Prop |
|-----------|----------|----------------|
| `appRoleArn` | `app.ts` | `IrsaServiceAccount({ iamRoleArn })` |
| `albControllerRoleArn` | *(EKS addon)* | Addon `ServiceAccountRoleArn` — managed by EKS, not K8s manifests |
| `externalDnsRoleArn` | `ingress.ts` | `ExternalDnsAgent({ iamRoleArn })` |
| `fluentBitRoleArn` | `observability.ts` | `FluentBitAgent({ iamRoleArn })` |
| `adotRoleArn` | `observability.ts` | `AdotCollector({ iamRoleArn })` |
| ACM cert ARN (via `just deploy-cert`) | `ingress.ts` | `AlbIngress({ certificateArn })` |
| Cluster name | `observability.ts` | `FluentBitAgent({ clusterName })`, `AdotCollector({ clusterName })` |

Values flow through `.env` → `config.ts` → K8s source files. `just load-outputs` refreshes `.env` after any infra deploy.

## Security hardening

This example includes EKS best-practice hardening:

- **IRSA condition blocks** — trust policies restrict `AssumeRoleWithWebIdentity` to a specific `system:serviceaccount:namespace:name` and audience `sts.amazonaws.com`, preventing cross-SA role assumption
- **Control plane logging** — all 5 log types (api, audit, authenticator, controllerManager, scheduler) enabled for CloudWatch
- **API endpoint restriction** — `PublicAccessCidrs` parameter lets you restrict API server access to your IP (defaults to 0.0.0.0/0; use `cidr=` to narrow)
- **AL2023 AMI** — node group uses `AL2023_x86_64_STANDARD` (current-gen, hardened by default)
- **Non-root container** — app runs `nginxinc/nginx-unprivileged` with `runAsNonRoot: true` on port 8080
- **KMS secrets encryption** — envelope encryption for Kubernetes secrets via a dedicated KMS key with automatic rotation
- **Pod Security Standards** — namespace enforces `restricted` PSS profile (enforce, warn, audit)
- **Health probes** — liveness and readiness probes on the app container for proper rollout gating
- **Topology spread** — zone-based `topologySpreadConstraints` with `maxSkew: 1` prevents single-AZ concentration
- **Metrics Server** — in-cluster metrics-server deployment enables HPA pod CPU/memory scaling

## Related examples

- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon
- [gitlab-aws-alb-api](../gitlab-aws-alb-api/) — AWS + GitLab cross-lexicon
