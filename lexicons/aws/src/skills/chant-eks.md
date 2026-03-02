---
skill: chant-eks
description: End-to-end EKS workflow bridging AWS infrastructure and Kubernetes workloads
user-invocable: true
---

# EKS End-to-End Workflow

## Overview

This skill bridges two lexicons:
- **`@intentius/chant-lexicon-aws`** — EKS cluster, node groups, IAM roles, OIDC provider (CloudFormation)
- **`@intentius/chant-lexicon-k8s`** — Kubernetes workloads, IRSA, ALB Ingress, storage, observability (K8s YAML)

## Architecture

```
AWS Lexicon (CloudFormation)          K8s Lexicon (kubectl apply)
┌────────────────────────┐           ┌────────────────────────────┐
│ VPC + Subnets          │           │ NamespaceEnv (quotas)      │
│ EKS Cluster            │           │ AutoscaledService (app)    │
│ Managed Node Group     │──ARNs──→  │ IrsaServiceAccount (IRSA)  │
│ OIDC Provider          │           │ AlbIngress (ALB)           │
│ IAM Roles (IRSA)       │           │ EbsStorageClass (gp3)      │
│ EKS Add-ons            │           │ FluentBitAgent (logs)      │
└────────────────────────┘           │ ExternalDnsAgent (DNS)     │
                                     └────────────────────────────┘
```

## Step 1: Provision AWS Infrastructure

```bash
# Build CloudFormation template
chant build src/infra/ --output infra.json

# Deploy
aws cloudformation deploy \
  --template-file infra.json \
  --stack-name my-eks-cluster \
  --capabilities CAPABILITY_NAMED_IAM
```

Key AWS resources:
- **EKS Cluster** — control plane
- **Managed Node Group** — EC2 worker nodes
- **OIDC Provider** — enables IRSA (IAM Roles for Service Accounts)
- **IAM Roles** — node role, app IRSA roles, ALB controller role

## Step 2: Configure kubectl

```bash
aws eks update-kubeconfig --name my-cluster --region us-east-1
kubectl get nodes  # verify connectivity
```

## Step 3: Deploy K8s Workloads

```bash
# Build K8s manifests
chant build src/k8s/ --output manifests.yaml

# Apply
kubectl apply -f manifests.yaml
```

### Key K8s composites for EKS

```typescript
import {
  NamespaceEnv,
  AutoscaledService,
  IrsaServiceAccount,
  AlbIngress,
  EbsStorageClass,
  FluentBitAgent,
  ExternalDnsAgent,
} from "@intentius/chant-lexicon-k8s";

// 1. Namespace with quotas and network isolation
const ns = NamespaceEnv({
  name: "prod",
  cpuQuota: "16",
  memoryQuota: "32Gi",
  defaultCpuRequest: "100m",
  defaultMemoryRequest: "128Mi",
  defaultDenyIngress: true,
});

// 2. IRSA ServiceAccount (use IAM Role ARN from CloudFormation outputs)
const irsa = IrsaServiceAccount({
  name: "app-sa",
  iamRoleArn: "arn:aws:iam::123456789012:role/app-role",  // from CF output
  namespace: "prod",
});

// 3. Application with autoscaling
const app = AutoscaledService({
  name: "api",
  image: "api:1.0",
  port: 8080,
  maxReplicas: 10,
  cpuRequest: "200m",
  memoryRequest: "256Mi",
  namespace: "prod",
});

// 4. ALB Ingress (use ACM cert ARN from CloudFormation outputs)
const ingress = AlbIngress({
  name: "api-ingress",
  hosts: [{ hostname: "api.example.com", paths: [{ path: "/", serviceName: "api", servicePort: 80 }] }],
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc",  // from CF output
  namespace: "prod",
});

// 5. Storage
const storage = EbsStorageClass({ name: "gp3-encrypted", type: "gp3", encrypted: true });

// 6. Observability
const logging = FluentBitAgent({
  logGroup: "/aws/eks/my-cluster/containers",
  region: "us-east-1",
  clusterName: "my-cluster",
});

// 7. DNS
const dns = ExternalDnsAgent({
  iamRoleArn: "arn:aws:iam::123456789012:role/external-dns-role",
  domainFilters: ["example.com"],
});
```

## Step 4: Verify

```bash
kubectl get pods -n prod
kubectl get ingress -n prod
kubectl logs -n amazon-cloudwatch -l app.kubernetes.io/name=fluent-bit
```

## Cleanup

```bash
# Delete K8s workloads first
kubectl delete -f manifests.yaml

# Then delete AWS infrastructure
aws cloudformation delete-stack --stack-name my-eks-cluster
aws cloudformation wait stack-delete-complete --stack-name my-eks-cluster
```

## Cross-Lexicon Value Flow

CloudFormation outputs flow into K8s composite props:

| CloudFormation Output | K8s Composite Prop |
|----------------------|-------------------|
| App IAM Role ARN | `IrsaServiceAccount.iamRoleArn` |
| ALB Controller Role ARN | `IrsaServiceAccount.iamRoleArn` (for ALB controller SA) |
| ACM Certificate ARN | `AlbIngress.certificateArn` |
| ExternalDNS Role ARN | `ExternalDnsAgent.iamRoleArn` |
| EKS Cluster Name | `FluentBitAgent.clusterName`, `AdotCollector.clusterName` |
| EFS Filesystem ID | `EfsStorageClass.fileSystemId` |

## EKS Init Template

Scaffold a dual-lexicon EKS project:

```bash
chant init --lexicon aws --template eks
```

This creates:
- `src/infra/` — EKS cluster, node group, IAM (AWS lexicon)
- `src/k8s/` — namespace, app, ingress, storage (K8s lexicon)
- `package.json` with both `@intentius/chant-lexicon-aws` and `@intentius/chant-lexicon-k8s`
