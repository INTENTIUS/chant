# CockroachDB Multi-Cloud on Kubernetes

One CockroachDB cluster spanning **EKS, AKS, and GKE** — 3 nodes per cloud, 9 nodes total.

All clouds deploy to the US East / Virginia metro for low cross-cloud latency (~2-5ms). Uses Chant's multi-stack layout: one project, subdirectories per cloud, each producing a separate output stack.

## Skills

The lexicon packages ship skills for agent-guided deployment. After `npm install`, your agent has access to:

| Skill | Package | Purpose |
|-------|---------|---------|
| `chant-aws` | `@intentius/chant-lexicon-aws` | CloudFormation lifecycle: build, validate, change sets, rollback |
| `chant-eks` | `@intentius/chant-lexicon-aws` | End-to-end EKS workflow bridging AWS infra and K8s workloads |
| `chant-azure` | `@intentius/chant-lexicon-azure` | ARM template lifecycle: build, validate, deploy, rollback |
| `chant-aks` | `@intentius/chant-lexicon-azure` | End-to-end AKS workflow bridging Azure infra and K8s workloads |
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | Config Connector lifecycle: build, lint, deploy, rollback |
| `chant-gke` | `@intentius/chant-lexicon-gcp` | End-to-end GKE workflow bridging GCP infra and K8s workloads |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | Kubernetes operational playbook: build, lint, apply, troubleshoot |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Advanced K8s patterns: sidecars, TLS, monitoring, network isolation |

> **Using Claude Code?** Just ask:
>
> ```
> Deploy the cockroachdb-multi-cloud example.
> ```

### Skills guide

This is a 4-lexicon, 3-cloud example. Each deployment phase maps to specific skills:

#### Phase 1 — Infrastructure (parallel, per cloud)

Each cloud has its own infra stack under `src/{eks,aks,gke}/infra/`. The cloud-specific lifecycle skills handle build → validate → deploy:

- **EKS**: `chant-aws` for CloudFormation lifecycle, `chant-eks` for the EKS-specific workflow (VPC, cluster, node groups, OIDC, IAM)
- **AKS**: `chant-azure` for ARM template lifecycle, `chant-aks` for the AKS-specific workflow (VNet, cluster, managed identities, role assignments)
- **GKE**: `chant-gcp` for Config Connector lifecycle, `chant-gke` for the GKE-specific workflow (VPC, cluster, node pool, service accounts)

#### Phase 2 — Kubernetes workloads (parallel, per cloud)

Each cloud has a K8s stack under `src/{eks,aks,gke}/k8s/`. Two skills cover this:

- **`chant-k8s`** — the operational playbook for build, lint, apply, rollback, and troubleshooting. Its composite decision tree identifies **CockroachDbCluster** as the right composite for this workload (StatefulSet + Services + PVCs + RBAC + optional cert generation).
- **`chant-k8s-patterns`** — advanced patterns if you need to extend the workloads (sidecars, monitoring, TLS, network isolation).

#### Skill workflow

```
1. chant-eks / chant-aks / chant-gke     "Deploy cloud infrastructure"
   │  (parallel — one per cloud)          → VPC, cluster, VPN, DNS
   │
2. chant-aws / chant-azure / chant-gcp   "CloudFormation / ARM / CC lifecycle"
   │  (referenced by the above)           → validate, change sets, rollback
   │
3. chant-k8s                              "Deploy K8s workloads"
   │  (parallel — one per cluster)        → CockroachDbCluster composite, apply, verify
   │
4. chant-k8s-patterns                     "Extend with advanced patterns"
                                          → sidecars, monitoring, TLS, network isolation
```

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
- A domain you control (set via `CRDB_DOMAIN` env var, e.g., `crdb.mycompany.com`)

### Required Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
# Edit .env with your values
set -a && source .env && set +a
```

**Domain:**
- `CRDB_DOMAIN` — base domain for UI ingress (subdomains: `eks.*`, `aks.*`, `gke.*`)

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

Replace `$CRDB_DOMAIN` with your domain below:

```bash
# AWS — Route53 hosted zone
aws route53 list-hosted-zones-by-name --dns-name "eks.${CRDB_DOMAIN}" \
  --query 'HostedZones[0].Id' --output text | xargs \
  aws route53 get-hosted-zone --id --query 'DelegationSet.NameServers'

# Azure — DNS zone
az network dns zone show \
  --name "aks.${CRDB_DOMAIN}" \
  --resource-group cockroachdb-rg \
  --query nameServers

# GCP — Cloud DNS managed zone
gcloud dns managed-zones describe gke-cockroachdb-zone \
  --format='value(nameServers)'
```

### Create NS records at your registrar

```
eks.<your-domain>  →  NS  (Route53 zone nameservers)
aks.<your-domain>  →  NS  (Azure DNS zone nameservers)
gke.<your-domain>  →  NS  (Cloud DNS zone nameservers)
```

### Verify

```bash
dig NS "eks.${CRDB_DOMAIN}"
dig NS "aks.${CRDB_DOMAIN}"
dig NS "gke.${CRDB_DOMAIN}"
```

**Note:** The CockroachDB cluster works without DNS delegation (uses internal K8s DNS for inter-node communication). Public UI ingress won't resolve until delegation is complete.

## Deploy

```bash
cp .env.example .env
# Fill in required values in .env
set -a && source .env && set +a
npm install
npm run deploy
```

### Standalone usage

To run this example outside the monorepo, copy `package.standalone.json` to `package.json`:

```bash
cp package.standalone.json package.json
npm install
```

### What `npm run deploy` does

The deploy is a **two-pass process**. The first pass deploys infrastructure with placeholder VPN IPs (each cloud doesn't know the others' public IPs yet). After infra is up, `load-outputs.sh` extracts real VPN IPs into `.env`. The second pass rebuilds and re-deploys with the real IPs so VPN tunnels can establish.

1. Builds all stacks (infra + K8s for each cloud)
2. Deploys infrastructure in parallel (EKS, AKS, GKE) — **first pass, placeholder VPN IPs**
3. Loads outputs (VPN IPs, endpoints) into `.env`
4. Rebuilds with real VPN IPs from `.env`
5. Re-deploys infrastructure — **second pass, real VPN IPs**
6. Waits for VPN tunnels to establish
7. Configures kubectl contexts
8. Generates and distributes TLS certificates
9. Applies K8s manifests in parallel
10. Restarts CoreDNS to pick up cross-cluster forwarding
11. Waits for StatefulSets to be ready
12. Runs `cockroach init`

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
- **Dashboard UI:** Public Ingress on `{cloud}.<CRDB_DOMAIN>` with cloud-native TLS (ALB/AGIC/GCE + cert-manager)
- **Multi-cloud cert generation:** Uses `scripts/generate-certs.sh` (external). The K8s composite's built-in cert-gen Job is for single-cluster deployments only.
