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

## Local verification (no cloud accounts required)

Verify the example builds and lints locally before deploying to 3 clouds:

```bash
cp .env.example .env
npm install
npm run build
npm run lint
```

This produces 6 output files in `dist/` — one infra template and one K8s manifest per cloud:

```
dist/eks-infra.json    dist/eks-k8s.yaml
dist/aks-infra.json    dist/aks-k8s.yaml
dist/gke-infra.json    dist/gke-k8s.yaml
```

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

## Source files

### Shared

| File | What it defines |
|------|-----------------|
| `src/shared/config.ts` | Cluster-wide constants: CIDR ranges (10.1/2/3.0.0/16), join addresses for all 9 nodes, CockroachDB version (v24.3.0) |

### EKS (AWS)

**Infrastructure** (`src/eks/infra/` → `dist/eks-infra.json`)

| File | Resources |
|------|-----------|
| `src/eks/config.ts` | EKS-specific config (cluster name, region, namespace, locality) |
| `src/eks/infra/networking.ts` | VpcDefault (VPC 10.1.0.0/16, subnets, NAT, IGW), SecurityGroup + ingress rules for CRDB ports from Azure/GCP CIDRs |
| `src/eks/infra/cluster.ts` | EKS cluster, node group (3x m5.xlarge), IAM roles (cluster + node), OIDC provider, KMS key, IRSA role bindings |
| `src/eks/infra/vpn.ts` | VPN gateway, 2x CustomerGateway (Azure + GCP peers), 2x VPN connections (IPsec tunnels) |
| `src/eks/infra/dns.ts` | Route53 hosted zone (`eks.<domain>`) |
| `src/eks/infra/addons.ts` | EKS add-ons: vpc-cni, ebs-csi-driver, coredns, kube-proxy |

**Kubernetes** (`src/eks/k8s/` → `dist/eks-k8s.yaml`)

| File | Resources |
|------|-----------|
| `src/eks/k8s/namespace.ts` | NamespaceEnv (crdb-eks), ResourceQuota (8 CPU / 32Gi), LimitRange, 2x NetworkPolicy (default-deny + CRDB cross-cloud allow) |
| `src/eks/k8s/storage.ts` | EbsStorageClass (gp3-encrypted, 3000 IOPS) |
| `src/eks/k8s/cockroachdb.ts` | CockroachDbCluster composite: StatefulSet (3 replicas), Services, RBAC, PDB, init + cert jobs |
| `src/eks/k8s/coredns.ts` | ConfigMap — CoreDNS forwarding for crdb-aks/crdb-gke namespaces over VPN |
| `src/eks/k8s/ingress.ts` | AlbIngress (CockroachDB UI), ExternalDnsAgent (Route53 DNS records) |

### AKS (Azure)

**Infrastructure** (`src/aks/infra/` → `dist/aks-infra.json`)

| File | Resources |
|------|-----------|
| `src/aks/config.ts` | AKS-specific config (cluster name, resource group, subscription, tenant) |
| `src/aks/infra/networking.ts` | VnetDefault (VNet 10.2.0.0/16, subnets, NSG), GatewaySubnet (10.2.255.0/27) |
| `src/aks/infra/cluster.ts` | AKS cluster (3x Standard_D4s_v5), ManagedIdentity for ExternalDNS, RoleAssignment (DNS Zone Contributor) |
| `src/aks/infra/vpn.ts` | PublicIP, VPN gateway (VpnGw1), 2x LocalNetworkGateway (AWS + GCP peers), 2x VPN connections |
| `src/aks/infra/dns.ts` | Azure DNS zone (`aks.<domain>`) |

**Kubernetes** (`src/aks/k8s/` → `dist/aks-k8s.yaml`)

| File | Resources |
|------|-----------|
| `src/aks/k8s/namespace.ts` | NamespaceEnv (crdb-aks), ResourceQuota, LimitRange, 2x NetworkPolicy |
| `src/aks/k8s/storage.ts` | AzureDiskStorageClass (Premium SSD) |
| `src/aks/k8s/cockroachdb.ts` | CockroachDbCluster composite: StatefulSet (3 replicas), Services, RBAC, PDB, init + cert jobs |
| `src/aks/k8s/coredns.ts` | ConfigMap — CoreDNS forwarding for crdb-eks/crdb-gke namespaces over VPN |
| `src/aks/k8s/ingress.ts` | AgicIngress (CockroachDB UI), AksExternalDnsAgent (Azure DNS records) |

### GKE (GCP)

**Infrastructure** (`src/gke/infra/` → `dist/gke-infra.json`)

| File | Resources |
|------|-----------|
| `src/gke/config.ts` | GKE-specific config (cluster name, project ID, region) |
| `src/gke/infra/networking.ts` | VpcNetwork (VPC 10.3.0.0/16, subnets, Cloud NAT), ComputeAddress (static IP), 2x Firewall (CRDB ports from AWS/Azure CIDRs) |
| `src/gke/infra/cluster.ts` | GKE cluster (3x e2-standard-4), GCP ServiceAccount, 2x IAMPolicyMember (workload identity + DNS admin) |
| `src/gke/infra/vpn.ts` | Cloud Router (BGP ASN 65003), HA VPN gateway, 2x ExternalVPNGateway (AWS + Azure), 4x VPN tunnels (redundant pairs), RouterInterfaces, RouterPeers |
| `src/gke/infra/dns.ts` | Cloud DNS managed zone (`gke.<domain>`) |

**Kubernetes** (`src/gke/k8s/` → `dist/gke-k8s.yaml`)

| File | Resources |
|------|-----------|
| `src/gke/k8s/namespace.ts` | NamespaceEnv (crdb-gke), ResourceQuota, LimitRange, 2x NetworkPolicy |
| `src/gke/k8s/storage.ts` | GcePdStorageClass (pd-ssd) |
| `src/gke/k8s/cockroachdb.ts` | CockroachDbCluster composite: StatefulSet (3 replicas), Services, RBAC, PDB, init + cert jobs |
| `src/gke/k8s/coredns.ts` | ConfigMap — CoreDNS forwarding for crdb-eks/crdb-aks namespaces over VPN |
| `src/gke/k8s/ingress.ts` | GceIngress (CockroachDB UI), GkeExternalDnsAgent (Cloud DNS records) |

## Resource counts

| Stack | Lexicon | Approximate resources |
|-------|---------|-----------------------|
| EKS infra | AWS (CloudFormation) | ~30 |
| EKS K8s | K8s | ~22 |
| AKS infra | Azure (ARM) | ~15 |
| AKS K8s | K8s | ~22 |
| GKE infra | GCP (Config Connector) | ~25 |
| GKE K8s | K8s | ~22 |
| **Total** | | **~136** |

## Cross-cloud value flow

The two-pass deploy uses `.env` to carry values between clouds and between infra → K8s layers.

### Pre-deploy (user-provided in `.env`)

| Env Var | Source | Consumed by |
|---------|--------|-------------|
| `CRDB_DOMAIN` | User | All `config.ts` files — base domain for DNS zones and ingress |
| `VPN_SHARED_SECRET` | User | All `vpn.ts` files — IPsec pre-shared key |
| `ALB_CERT_ARN` | AWS ACM | `src/eks/k8s/ingress.ts` → AlbIngress TLS cert |
| `EXTERNAL_DNS_ROLE_ARN` | AWS IAM | `src/eks/k8s/ingress.ts` → ExternalDnsAgent IRSA |
| `AZURE_SUBSCRIPTION_ID` | Azure | `src/aks/config.ts` → ARM deployment scope |
| `AZURE_TENANT_ID` | Azure | `src/aks/k8s/ingress.ts` → AksExternalDnsAgent workload identity |
| `EXTERNAL_DNS_CLIENT_ID` | Azure | `src/aks/k8s/ingress.ts` → AksExternalDnsAgent managed identity |
| `GCP_PROJECT_ID` | GCP | `src/gke/config.ts` → Config Connector project scope |
| `EXTERNAL_DNS_GSA_EMAIL` | GCP | `src/gke/k8s/ingress.ts` → GkeExternalDnsAgent workload identity |

### Post-deploy (populated by `scripts/load-outputs.sh`)

These values are unknown until infrastructure is deployed, creating the two-pass requirement:

| Env Var | Extracted from | Consumed by |
|---------|---------------|-------------|
| `AWS_VPN_PUBLIC_IP` | CloudFormation outputs | `src/aks/infra/vpn.ts` (AWS local gateway), `src/gke/infra/vpn.ts` (AWS external gateway) |
| `AZURE_VPN_PUBLIC_IP` | ARM deployment outputs | `src/eks/infra/vpn.ts` (Azure customer gateway), `src/gke/infra/vpn.ts` (Azure external gateway) |
| `GCP_VPN_PUBLIC_IP` | GCP deployment outputs | `src/eks/infra/vpn.ts` (GCP customer gateway), `src/aks/infra/vpn.ts` (GCP local gateway) |

### Data flow diagram

```
.env (user)  ──►  config.ts (per cloud)  ──►  infra/*.ts  ──►  deploy  ──►  outputs
                                                                                │
.env (auto)  ◄──  scripts/load-outputs.sh  ◄────────────────────────────────────┘
     │
     └──►  config.ts (per cloud)  ──►  vpn.ts (rebuild with real IPs)  ──►  re-deploy
```

## TLS Strategy

- **Inter-node + client:** Self-signed CA via `cockroach cert` (generated locally, distributed as K8s Secrets). One node cert with SANs for all 9 nodes across all 3 clusters.
- **Dashboard UI:** Public Ingress on `{cloud}.<CRDB_DOMAIN>` with cloud-native TLS (ALB/AGIC/GCE + cert-manager)
- **Multi-cloud cert generation:** Uses `scripts/generate-certs.sh` (external). The K8s composite's built-in cert-gen Job is for single-cluster deployments only.

## Security hardening

1. **Pod Security Standards** — all namespaces enforce `baseline` with `restricted` warn/audit, blocking privileged containers
2. **Default-deny NetworkPolicy** — each namespace starts with deny-all ingress; a second policy explicitly allows CockroachDB ports (26257 gRPC, 8080 HTTP) only from the 3 VPC CIDRs
3. **Cloud-level firewalls** — AWS SecurityGroup ingress rules, Azure NSG, GCP Firewall rules all restrict CRDB ports to peer VPC CIDRs only
4. **Encrypted inter-node traffic** — CockroachDB TLS with self-signed CA; all node-to-node and client-to-node traffic is mTLS
5. **Encrypted storage** — EBS gp3 with encryption, Azure Premium SSD (encrypted at rest), GCP pd-ssd (encrypted at rest)
6. **IPsec VPN mesh** — all cross-cloud traffic traverses encrypted VPN tunnels with pre-shared key authentication
7. **Workload identity** — IRSA on EKS, Managed Identity on AKS, Workload Identity Federation on GKE; no long-lived credentials in K8s
8. **Resource quotas + LimitRange** — each namespace caps at 8 CPU / 32Gi memory with per-pod defaults and limits
9. **Non-root containers** — CockroachDB runs as non-root (UID 1000) with read-only root filesystem where supported
10. **PodDisruptionBudget** — ensures at least 2 of 3 pods per cloud remain available during node maintenance

## Testing

### Local build verification

```bash
cp .env.example .env
npm install
npm run build    # produces 6 artifacts in dist/
npm run lint     # runs chant lint on all 3 stacks
```

### Full E2E deployment

```bash
# Fill in .env with real credentials
npm run deploy   # two-pass deploy across all 3 clouds
# Verify (see Verify section above)
npm run teardown
```

### Docker smoke tests

The repo-level smoke tests (`test/smoke.sh`) verify packages install and build in a clean Docker environment. They are **not** for E2E validation — use `npm run deploy` for that.

## Related examples

- **[k8s-eks-microservice](../k8s-eks-microservice/)** — single-cloud EKS with ALB ingress, IRSA, and observability
- **[k8s-aks-microservice](../k8s-aks-microservice/)** — single-cloud AKS with AGIC ingress and workload identity
- **[k8s-gke-microservice](../k8s-gke-microservice/)** — single-cloud GKE with GCE ingress and workload identity
