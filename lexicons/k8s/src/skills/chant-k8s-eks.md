---
skill: chant-k8s-eks
description: EKS-specific Kubernetes patterns and composites
user-invocable: true
---

# EKS Kubernetes Patterns

## EKS Composites Overview

These composites produce K8s YAML with EKS-specific annotations and configurations.

### IrsaServiceAccount — ServiceAccount with IAM Role annotation

```typescript
import { IrsaServiceAccount } from "@intentius/chant-lexicon-k8s";

const { serviceAccount, role, roleBinding } = IrsaServiceAccount({
  name: "app-sa",
  iamRoleArn: "arn:aws:iam::123456789012:role/my-app-role",
  rbacRules: [
    { apiGroups: [""], resources: ["secrets"], verbs: ["get"] },
  ],
  namespace: "prod",
});
```

### AlbIngress — Ingress with AWS ALB Controller annotations

```typescript
import { AlbIngress } from "@intentius/chant-lexicon-k8s";

const { ingress } = AlbIngress({
  name: "api-ingress",
  hosts: [
    {
      hostname: "api.example.com",
      paths: [{ path: "/", serviceName: "api", servicePort: 80 }],
    },
  ],
  scheme: "internet-facing",
  certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/abc-123",
  groupName: "shared-alb",
  healthCheckPath: "/healthz",
});
```

Features:
- Auto-sets `alb.ingress.kubernetes.io/*` annotations
- SSL redirect enabled by default when `certificateArn` set
- `groupName` for shared ALB across multiple Ingresses
- `wafAclArn` for WAFv2 integration

### EbsStorageClass — StorageClass for EBS CSI

```typescript
import { EbsStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = EbsStorageClass({
  name: "gp3-encrypted",
  type: "gp3",
  encrypted: true,
  iops: "3000",
  throughput: "125",
});
```

### EfsStorageClass — StorageClass for EFS CSI (ReadWriteMany)

```typescript
import { EfsStorageClass } from "@intentius/chant-lexicon-k8s";

const { storageClass } = EfsStorageClass({
  name: "efs-shared",
  fileSystemId: "fs-12345678",
});
```

Use EFS when you need ReadWriteMany (shared across pods/nodes). Use EBS for ReadWriteOnce (single pod).

### FluentBitAgent — DaemonSet for CloudWatch logging

```typescript
import { FluentBitAgent } from "@intentius/chant-lexicon-k8s";

const result = FluentBitAgent({
  logGroup: "/aws/eks/my-cluster/containers",
  region: "us-east-1",
  clusterName: "my-cluster",
});
```

### ExternalDnsAgent — ExternalDNS for Route53

```typescript
import { ExternalDnsAgent } from "@intentius/chant-lexicon-k8s";

const result = ExternalDnsAgent({
  iamRoleArn: "arn:aws:iam::123456789012:role/external-dns-role",
  domainFilters: ["example.com"],
  txtOwnerId: "my-cluster",
});
```

### AdotCollector — ADOT for CloudWatch/X-Ray

```typescript
import { AdotCollector } from "@intentius/chant-lexicon-k8s";

const result = AdotCollector({
  region: "us-east-1",
  clusterName: "my-cluster",
  exporters: ["cloudwatch", "xray"],
});
```

## Pod Identity vs IRSA

| Feature | IRSA | Pod Identity |
|---------|------|-------------|
| K8s annotation needed | Yes (`eks.amazonaws.com/role-arn`) | No |
| Composite available | **IrsaServiceAccount** | None needed |
| Setup | OIDC provider + IAM role trust policy | EKS Pod Identity Agent add-on + association |
| When to use | Existing clusters, broad compatibility | New clusters (EKS 1.28+), simpler management |

For Pod Identity, no K8s-side composite is needed — configure the association via AWS API/CloudFormation and use a plain ServiceAccount.

## Karpenter

Karpenter replaces Cluster Autoscaler for node provisioning. Karpenter NodePool and EC2NodeClass are simple CRDs — use CRD import rather than composites:

```bash
# Import Karpenter CRDs into your chant project
chant import --url https://raw.githubusercontent.com/aws/karpenter/main/pkg/apis/crds/karpenter.sh_nodepools.yaml
```

## Fargate Considerations

When running on EKS Fargate:
- **No DaemonSets** — FluentBitAgent and AdotCollector cannot run on Fargate nodes
- **No hostPath volumes** — use EFS for shared storage
- **No privileged containers** — security context restrictions apply
- For Fargate logging, use the built-in Fluent Bit log router (Fargate logging configuration)

## EKS Add-ons

Common add-ons managed via AWS (not K8s manifests):
- **vpc-cni** — Amazon VPC CNI plugin
- **coredns** — Cluster DNS
- **kube-proxy** — Network proxy
- **aws-ebs-csi-driver** — EBS CSI driver (required for EbsStorageClass)
- **aws-efs-csi-driver** — EFS CSI driver (required for EfsStorageClass)
- **adot** — AWS Distro for OpenTelemetry (alternative to AdotCollector composite)
- **aws-guardduty-agent** — Runtime threat detection

Configure add-ons via the AWS lexicon (`@intentius/chant-lexicon-aws`) CloudFormation resources.
