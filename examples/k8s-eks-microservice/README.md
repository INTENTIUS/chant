# EKS Microservice — Cross-Lexicon Example

A production-grade cross-lexicon example that defines both **AWS EKS infrastructure** (CloudFormation via the AWS lexicon) and **Kubernetes workloads** (YAML via the K8s lexicon) — all in TypeScript.

This demonstrates chant's multi-lexicon capability: a single `src/` directory imports from both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-k8s`, and builds to two separate outputs.

## Source files

### AWS infrastructure (`src/infra/`)

| File | Description |
|------|-------------|
| `networking.ts` | VPC with public/private subnets, IGW, NAT gateway |
| `cluster.ts` | EKS cluster, managed node group, OIDC provider, IAM roles (cluster, node, app IRSA, ALB controller, ExternalDNS, FluentBit, ADOT) |
| `addons.ts` | EKS add-ons: vpc-cni, aws-ebs-csi-driver, coredns, kube-proxy, aws-load-balancer-controller |
| `params.ts` | CloudFormation parameters: environment, domainName, certificateArn, publicAccessCidr |

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
│  │ coredns, kube-proxy,    │      │
│  │ ALB controller           │      │
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
│  ┌────────────┐                    │
│  │ ADOT       │                    │
│  │ Collector  │                    │
│  └────────────┘                    │
└─────────────────────────────────────┘
```

## Resource counts

- **32 CloudFormation resources**: 17 VPC + 1 cluster + 1 nodegroup + 1 OIDC + 7 IAM roles + 5 addons
- **28 Kubernetes resources**: across 5 source files (namespace, app, ingress, storage, observability)

## Skills guide

Chant provides four skills that walk you through every aspect of this example. Use them as interactive guides during development.

### Getting started: `chant-eks`

The **`chant-eks`** skill (AWS lexicon) is the primary entry point for end-to-end EKS projects. It covers the full workflow from provisioning infrastructure to deploying workloads, including:

- How AWS CloudFormation outputs (IAM Role ARNs, cluster endpoint) flow into K8s composite props
- Cross-lexicon value mapping table: which CF output feeds which K8s composite prop
- Scaffolding a dual-lexicon project with `chant init --lexicon aws --template eks`

Start here when you're building a new EKS project from scratch or need to understand how the two lexicons connect.

### EKS-specific K8s composites: `chant-k8s-eks`

The **`chant-k8s-eks`** skill (K8s lexicon) covers the EKS composites used in `src/k8s/`:

| This example uses | Skill section |
|-------------------|---------------|
| `IrsaServiceAccount` in `app.ts` | IRSA setup, `eks.amazonaws.com/role-arn` annotation |
| `AlbIngress` in `ingress.ts` | ALB Controller annotations, SSL redirect, shared ALB groups |
| `EbsStorageClass` in `storage.ts` | EBS CSI provisioner, gp3 vs gp2, encryption |
| `FluentBitAgent` in `observability.ts` | DaemonSet config, CloudWatch output plugin |
| `AdotCollector` in `observability.ts` | DaemonSet config, CloudWatch metrics pipeline |
| `ExternalDnsAgent` in `ingress.ts` | Route53 integration, domain filters, IRSA |

### Core K8s composites: `chant-k8s`

The **`chant-k8s`** skill (K8s lexicon) is the comprehensive reference for all 20 composites. It includes:

- **"Choosing the Right Composite" decision tree** — which composite to use for each workload type
- Hardening options: `minAvailable` (PDB), `initContainers`, `securityContext`, `priorityClassName`
- Build/lint/apply workflow and troubleshooting reference

### Advanced patterns: `chant-k8s-patterns`

The **`chant-k8s-patterns`** skill (K8s lexicon) covers patterns you might add to this example next:

- **Sidecars** — add an Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — use `ConfiguredApp` to wire ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — use `SecureIngress` instead of `AlbIngress` for non-AWS ingress controllers
- **Prometheus monitoring** — add `MonitoredService` with ServiceMonitor and alert rules

### Skill workflow for this example

```
1. chant-eks          "How do I set up EKS end-to-end?"
   │                  → Scaffold project, provision infra, deploy workloads
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

## Prerequisites

- **AWS CLI** >= 2.x configured with EKS permissions
- **kubectl** installed
- **jq** installed (for `just load-outputs`)
- **Bun** runtime
- **ACM certificate** pre-created in the target region (for ALB TLS)
- **Route53 hosted zone** for the domain (for ExternalDNS)

## Step 1: Deploy infrastructure

```bash
# Build CloudFormation template
just build
# or: chant build src --lexicon aws -o templates/infra.json

# Lint (optional)
just lint

# Deploy (creates 32 resources including ALB controller addon)
# Pass your domain and ACM cert ARN (optionally restrict API endpoint access):
just deploy-infra domain=myapp.example.com cert=arn:aws:acm:us-east-1:123456789012:certificate/your-cert-id cidr=203.0.113.1/32
```

The stack exports 12 outputs: VPC ID, 4 subnet IDs, cluster endpoint/ARN, and 5 IAM role ARNs (app, ALB controller, ExternalDNS, FluentBit, ADOT). The ALB controller addon installs automatically — no Helm or CRDs to manage.

## Security hardening

This example includes EKS best-practice hardening:

- **IRSA condition blocks** — trust policies restrict `AssumeRoleWithWebIdentity` to a specific `system:serviceaccount:namespace:name` and audience `sts.amazonaws.com`, preventing cross-SA role assumption
- **Control plane logging** — all 5 log types (api, audit, authenticator, controllerManager, scheduler) enabled for CloudWatch
- **API endpoint restriction** — `PublicAccessCidrs` parameter lets you restrict API server access to your IP (defaults to 0.0.0.0/0; use `cidr=` to narrow)
- **AL2023 AMI** — node group uses `AL2023_x86_64_STANDARD` (current-gen, hardened by default)
- **Non-root container** — app runs `nginxinc/nginx-unprivileged` with `runAsNonRoot: true` on port 8080

## Step 2: Configure kubectl and load outputs

```bash
# Update kubeconfig
just configure-kubectl
kubectl get nodes  # verify connectivity

# Populate .env with real ARNs from stack outputs
just load-outputs
```

The `load-outputs` target queries CloudFormation stack outputs (IAM role ARNs) and parameters (domain, cert ARN) and writes them to `.env`. Bun auto-loads `.env` at runtime, so the next K8s build picks up real values instead of placeholders.

## Step 3: Deploy workloads

```bash
# Rebuild K8s manifests with real ARNs (28 resources across 5 files)
just build-k8s

# Validate before applying (optional)
just validate

# Apply
just apply

# Wait for rollout
just wait
```

For K8s-only changes, use `just build-k8s` — no need to rebuild the CF template.

## Step 4: Verify

```bash
# All-in-one status check
just status

# Application pods
kubectl get pods -n microservice
kubectl rollout status deployment/microservice-api -n microservice

# Ingress (ALB may take 2-3 minutes to provision)
kubectl get ingress -n microservice
kubectl describe ingress microservice-alb -n microservice

# Observability — logging
kubectl get daemonsets -n amazon-cloudwatch
kubectl logs -n amazon-cloudwatch -l app.kubernetes.io/name=fluent-bit --tail=20

# Observability — metrics
kubectl get daemonsets -n amazon-metrics

# ALB controller
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller

# DNS
kubectl get pods -n kube-system -l app.kubernetes.io/name=external-dns

# Storage
kubectl get storageclass gp3-encrypted

# App logs
just logs
```

## Cross-lexicon value flow

CloudFormation stack outputs map to K8s composite props via `.env`:

| CF Output | K8s File | Composite Prop |
|-----------|----------|----------------|
| `appRoleArn` | `app.ts` | `IrsaServiceAccount({ iamRoleArn })` |
| `albControllerRoleArn` | *(EKS addon)* | Addon `ServiceAccountRoleArn` — managed by EKS, not K8s manifests |
| `externalDnsRoleArn` | `ingress.ts` | `ExternalDnsAgent({ iamRoleArn })` |
| `fluentBitRoleArn` | `observability.ts` | `FluentBitAgent({ iamRoleArn })` |
| `adotRoleArn` | `observability.ts` | `AdotCollector({ iamRoleArn })` |
| ACM cert ARN | `ingress.ts` | `AlbIngress({ certificateArn })` |
| Cluster name | `observability.ts` | `FluentBitAgent({ clusterName })`, `AdotCollector({ clusterName })` |

Values flow through `.env` → `config.ts` → K8s source files. Run `just load-outputs` after any infra deploy to refresh. The `.env` includes both stack outputs (IAM role ARNs) and stack parameters (domain name, ACM cert ARN).

## Cleanup

```bash
just teardown
```

This deletes K8s resources first, waits 30s for the ALB to drain, then deletes the CloudFormation stack. **Delete order matters** — if you delete the CF stack first, the ALB controller addon is removed and can't clean up the ALB.

## Related examples

- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon
- [gitlab-aws-alb-api](../gitlab-aws-alb-api/) — AWS + GitLab cross-lexicon
