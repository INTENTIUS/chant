# CockroachDB Multi-Cloud on Kubernetes

One CockroachDB cluster spanning **EKS, AKS, and GKE** — 3 nodes per cloud, 9 nodes total.

All clouds deploy to the US East / Virginia metro for low cross-cloud latency (~2-5ms). Uses Chant's multi-stack layout: one project, subdirectories per cloud, each producing a separate output stack.

## Architecture

```
┌─────────────────┐    VPN    ┌─────────────────┐    VPN    ┌─────────────────┐
│   AWS EKS        │◄────────►│   Azure AKS      │◄────────►│   GCP GKE        │
│   us-east-1      │          │   eastus          │          │   us-east4       │
│   10.1.0.0/16    │          │   10.2.0.0/16     │          │   10.3.0.0/16    │
│                  │          │                   │          │                  │
│  cockroachdb-0   │          │  cockroachdb-0    │          │  cockroachdb-0   │
│  cockroachdb-1   │          │  cockroachdb-1    │          │  cockroachdb-1   │
│  cockroachdb-2   │          │  cockroachdb-2    │          │  cockroachdb-2   │
│  (crdb-eks ns)   │          │  (crdb-aks ns)    │          │  (crdb-gke ns)   │
└─────────────────┘          └─────────────────┘          └─────────────────┘
        ▲                            ▲                            ▲
        └────────────────────────────┴────────────────────────────┘
                         Full-mesh IPsec VPN
```

## Prerequisites

- AWS CLI configured (`aws configure`)
- Azure CLI configured (`az login`)
- Google Cloud CLI configured (`gcloud auth login`)
- `kubectl` installed
- `docker` installed (for cert generation)
- Domain `crdb.intentius.io` with registrar access

### Required Environment Variables

Set these before deploying. Placeholder defaults exist but will produce broken configs.

**AWS (EKS):**
- `AWS_REGION` — AWS region (default: `us-east-1`)
- `EKS_CLUSTER_NAME` — EKS cluster name (default: `eks-cockroachdb`)
- `ALB_CERT_ARN` — ACM certificate ARN for ALB TLS
- `EXTERNAL_DNS_ROLE_ARN` — IAM role ARN for ExternalDNS

**Azure (AKS):**
- `AKS_CLUSTER_NAME` — AKS cluster name (default: `aks-cockroachdb`)
- `AZURE_RESOURCE_GROUP` — Resource group name (default: `cockroachdb-rg`)
- `AZURE_SUBSCRIPTION_ID` — Azure subscription ID
- `AZURE_TENANT_ID` — Azure tenant ID
- `EXTERNAL_DNS_CLIENT_ID` — Managed identity client ID for ExternalDNS

**GCP (GKE):**
- `GKE_CLUSTER_NAME` — GKE cluster name (default: `gke-cockroachdb`)
- `GCP_PROJECT_ID` — GCP project ID
- `EXTERNAL_DNS_GSA_EMAIL` — GCP service account email for ExternalDNS

**Shared:**
- `VPN_SHARED_SECRET` — Pre-shared key for IPsec VPN tunnels

## DNS Delegation (One-Time Setup)

After Step 2 (infrastructure deploy), delegate each subdomain at your registrar.

### Get nameservers from each cloud

```bash
# AWS — Route53 hosted zone
aws route53 list-hosted-zones-by-name --dns-name eks.crdb.intentius.io \
  --query 'HostedZones[0].Id' --output text | xargs \
  aws route53 get-hosted-zone --id --query 'DelegationSet.NameServers'

# Azure — DNS zone
az network dns zone show \
  --name aks.crdb.intentius.io \
  --resource-group cockroachdb-rg \
  --query nameServers

# GCP — Cloud DNS managed zone
gcloud dns managed-zones describe gke-cockroachdb-zone \
  --format='value(nameServers)'
```

### Create NS records at your registrar

```
eks.crdb.intentius.io  →  NS  (Route53 zone nameservers)
aks.crdb.intentius.io  →  NS  (Azure DNS zone nameservers)
gke.crdb.intentius.io  →  NS  (Cloud DNS zone nameservers)
```

### Verify

```bash
dig NS eks.crdb.intentius.io
dig NS aks.crdb.intentius.io
dig NS gke.crdb.intentius.io
```

**Note:** The CockroachDB cluster works without DNS delegation (uses internal K8s DNS for inter-node communication). Public UI ingress won't resolve until delegation is complete.

## Deploy

```bash
npm install
npm run deploy
```

This runs `scripts/deploy.sh` which:
1. Builds all stacks (infra + K8s for each cloud)
2. Deploys infrastructure in parallel (EKS, AKS, GKE)
3. Loads outputs (VPN IPs, endpoints)
4. Rebuilds with real VPN IPs
5. Configures kubectl contexts
6. Generates and distributes TLS certificates
7. Applies K8s manifests in parallel
8. Restarts CoreDNS to pick up cross-cluster forwarding
9. Waits for StatefulSets to be ready
10. Runs `cockroach init`

## Verify

```bash
# Check all pods are running
kubectl --context eks get pods -n crdb-eks
kubectl --context aks get pods -n crdb-aks
kubectl --context gke get pods -n crdb-gke

# Check CockroachDB cluster status (should show all 9 nodes)
kubectl --context eks exec cockroachdb-0 -n crdb-eks -- \
  /cockroach/cockroach node status --certs-dir=/cockroach/cockroach-certs

# Connect via SQL
kubectl --context eks exec -it cockroachdb-0 -n crdb-eks -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-certs
```

## Teardown

```bash
npm run teardown
```

## Cost Estimate

~$2.18/hr (~$52/day) total across all 3 clouds. Teardown after testing to avoid charges.

| Component | AWS | Azure | GCP |
|-----------|-----|-------|-----|
| Control plane | $0.10/hr | Free | $0.10/hr |
| 3x nodes | ~$0.58/hr | ~$0.58/hr | ~$0.50/hr |
| Storage | ~$0.03/hr | ~$0.03/hr | ~$0.03/hr |
| VPN | ~$0.05/hr | ~$0.04/hr | ~$0.05/hr |

## Project Structure

```
src/
├── shared/config.ts          # Shared join addresses, cluster name
├── eks/                      # AWS EKS stack
│   ├── config.ts
│   ├── chant.config.json
│   ├── infra/                # VPC, EKS cluster, VPN, DNS
│   └── k8s/                  # CockroachDB, namespace, storage, ingress
├── aks/                      # Azure AKS stack
│   ├── config.ts
│   ├── chant.config.json
│   ├── infra/                # VNet, AKS cluster, VPN, DNS
│   └── k8s/                  # CockroachDB, namespace, storage, ingress
└── gke/                      # GCP GKE stack
    ├── config.ts
    ├── chant.config.json
    ├── infra/                # VPC, GKE cluster, VPN, DNS
    └── k8s/                  # CockroachDB, namespace, storage, ingress
scripts/
├── deploy.sh                 # Full deploy orchestrator
├── teardown.sh               # Full teardown
├── generate-certs.sh         # TLS cert generation + distribution
└── load-outputs.sh           # Extract cloud outputs to .env
```

## TLS Strategy

- **Inter-node + client:** Self-signed CA via `cockroach cert` (generated locally, distributed as K8s Secrets). One node cert with SANs for all 9 nodes across all 3 clusters.
- **Dashboard UI:** Public Ingress on `{cloud}.crdb.intentius.io` with cloud-native TLS (ALB/AGIC/GCE + cert-manager)
- **Multi-cloud cert generation:** Uses `scripts/generate-certs.sh` (external). The K8s composite's built-in cert-gen Job is for single-cluster deployments only.
