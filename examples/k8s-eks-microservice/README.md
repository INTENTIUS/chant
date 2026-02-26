# EKS Microservice — Cross-Lexicon Example

A production-grade cross-lexicon example that defines both **AWS EKS infrastructure** (CloudFormation via the AWS lexicon) and **Kubernetes workloads** (YAML via the K8s lexicon) — all in TypeScript.

This demonstrates chant's multi-lexicon capability: a single `src/` directory imports from both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-k8s`, and builds to two separate outputs.

## Source files

### AWS infrastructure (`src/infra/`)

| File | Description |
|------|-------------|
| `networking.ts` | VPC with public/private subnets, IGW, NAT gateway |
| `cluster.ts` | EKS cluster, managed node group, OIDC provider, IAM roles (cluster, node, app IRSA, ALB controller, ExternalDNS, FluentBit) |
| `addons.ts` | EKS add-ons: vpc-cni, aws-ebs-csi-driver, coredns, kube-proxy |

### K8s workloads (`src/k8s/`)

| File | Composites Used | Description |
|------|-----------------|-------------|
| `namespace.ts` | `NamespaceEnv` | Namespace with resource quotas, limit ranges, default-deny NetworkPolicy |
| `app.ts` | `AutoscaledService`, `IrsaServiceAccount` | App Deployment + Service + HPA + PDB + IRSA ServiceAccount + ConfigMap |
| `ingress.ts` | `AlbIngress`, `ExternalDnsAgent` | ALB Ingress with TLS + ExternalDNS for Route53 |
| `storage.ts` | `EbsStorageClass` | gp3 encrypted StorageClass |
| `observability.ts` | `FluentBitAgent` | Fluent Bit DaemonSet for CloudWatch logging |

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
└───────┼─────────────────────────────┘
        │ ARNs flow down
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
└─────────────────────────────────────┘
```

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
| `ExternalDnsAgent` in `ingress.ts` | Route53 integration, domain filters, IRSA |

It also covers decision points not in this example:
- **Pod Identity vs IRSA** — when to use each (this example uses IRSA)
- **EFS vs EBS** — `EfsStorageClass` for ReadWriteMany workloads
- **AdotCollector** — alternative to FluentBit for OpenTelemetry-based observability
- **Fargate considerations** — what cannot run on Fargate (DaemonSets, hostPath)
- **Karpenter** — node autoscaling via CRD import

### Core K8s composites: `chant-k8s`

The **`chant-k8s`** skill (K8s lexicon) is the comprehensive reference for all 20 composites. It includes:

- **"Choosing the Right Composite" decision tree** — which composite to use for each workload type
- Hardening options: `minAvailable` (PDB), `initContainers`, `securityContext`, `priorityClassName`
- Build/lint/apply workflow and troubleshooting reference
- Common error patterns and how to diagnose them

Use this skill when choosing composites for new workloads or troubleshooting deployment issues.

### Advanced patterns: `chant-k8s-patterns`

The **`chant-k8s-patterns`** skill (K8s lexicon) covers patterns you might add to this example next:

- **Sidecars** — add an Envoy proxy or log forwarder with `SidecarApp`
- **Config/Secret mounting** — use `ConfiguredApp` to wire ConfigMap volumes and Secret env vars
- **TLS with cert-manager** — use `SecureIngress` instead of `AlbIngress` for non-AWS ingress controllers
- **Prometheus monitoring** — add `MonitoredService` with ServiceMonitor and alert rules
- **Network isolation** — per-app NetworkPolicy with `NetworkIsolatedApp`
- **Blue/Green and Canary** — deployment strategies using standard composites

### Skill workflow for this example

```
1. chant-eks          "How do I set up EKS end-to-end?"
   │                  → Scaffold project, provision infra, deploy workloads
   │
2. chant-k8s-eks      "Which EKS composites do I need?"
   │                  → IRSA, ALB, EBS, FluentBit, ExternalDNS
   │
3. chant-k8s          "How do I choose between composites?"
   │                  → Decision tree, hardening options, troubleshooting
   │
4. chant-k8s-patterns "What patterns can I add next?"
                      → Sidecars, monitoring, TLS, network isolation
```

## Prerequisites

- AWS CLI configured with EKS permissions
- `kubectl` installed
- Bun runtime

## Step 1: Deploy infrastructure

```bash
# Build CloudFormation template
chant build src --lexicon aws -o templates/infra.json

# Validate (optional)
chant lint src

# Deploy
aws cloudformation deploy \
  --template-file templates/infra.json \
  --stack-name eks-microservice \
  --capabilities CAPABILITY_NAMED_IAM

# Capture outputs for Step 3
aws cloudformation describe-stacks \
  --stack-name eks-microservice \
  --query 'Stacks[0].Outputs' \
  --output table
```

The stack exports 11 outputs: VPC ID, 4 subnet IDs, cluster endpoint/ARN, and 4 IAM role ARNs. The role ARNs are referenced in the K8s workload files (`app.ts`, `ingress.ts`, `observability.ts`).

## Step 2: Configure kubectl

```bash
aws eks update-kubeconfig --name eks-microservice --region us-east-1
kubectl get nodes  # verify connectivity
```

## Step 3: Deploy workloads

```bash
# Build K8s manifests (21 resources across 5 files)
chant build src --lexicon k8s -o k8s.yaml

# Validate before applying
kubectl apply -f k8s.yaml --dry-run=server

# Apply
kubectl apply -f k8s.yaml
```

## Step 4: Verify

```bash
# Application pods
kubectl get pods -n microservice
kubectl rollout status deployment/microservice-api -n microservice

# Ingress (ALB may take 2-3 minutes to provision)
kubectl get ingress -n microservice
kubectl describe ingress microservice-alb -n microservice

# Observability
kubectl get daemonsets -n amazon-cloudwatch
kubectl logs -n amazon-cloudwatch -l app.kubernetes.io/name=fluent-bit --tail=20

# DNS
kubectl get pods -n kube-system -l app.kubernetes.io/name=external-dns
kubectl logs -n kube-system -l app.kubernetes.io/name=external-dns --tail=20

# Storage
kubectl get storageclass gp3-encrypted
```

## Cross-lexicon value flow

CloudFormation stack outputs map to K8s composite props:

| CF Output | K8s File | Composite Prop |
|-----------|----------|----------------|
| `appRoleArn` | `app.ts` | `IrsaServiceAccount({ iamRoleArn })` |
| `albControllerRoleArn` | *(ALB controller install)* | `IrsaServiceAccount({ iamRoleArn })` |
| `externalDnsRoleArn` | `ingress.ts` | `ExternalDnsAgent({ iamRoleArn })` |
| `fluentBitRoleArn` | `observability.ts` | `FluentBitAgent({ iamRoleArn })` |
| ACM cert ARN | `ingress.ts` | `AlbIngress({ certificateArn })` |
| Cluster name | `observability.ts` | `FluentBitAgent({ clusterName })` |

In this example, the ARNs are hardcoded placeholders. In production, pass them via environment variables or a shared config file populated from `aws cloudformation describe-stacks`.

## Cleanup

```bash
# Delete K8s workloads first (releases ALB, DNS records)
kubectl delete -f k8s.yaml

# Wait for ALB to drain
sleep 30

# Delete AWS infrastructure
aws cloudformation delete-stack --stack-name eks-microservice
aws cloudformation wait stack-delete-complete --stack-name eks-microservice
```

## Related examples

- [flyway-postgresql-k8s](../flyway-postgresql-k8s/) — K8s + Flyway cross-lexicon
- [gitlab-aws-alb-api](../gitlab-aws-alb-api/) — AWS + GitLab cross-lexicon
