# CockroachDB Multi-Region on GKE

> **New to chant?** Start with the [golden teaching example](../getting-started/) — synthesis, lint, Ops, and the lifecycle dial over one set of declarations — then come back here for a production-shaped deployment.

One CockroachDB cluster spanning **3 GCP regions** — 3 nodes per region, 9 nodes total.

A single global VPC routes between regions natively (~25-45ms). No VPN, no two-pass deploy, one IAM system. A management cluster running Config Connector turns the GCP half of the build output into real infrastructure; the Kubernetes half goes to the three workload clusters it creates.

```bash
npm run smoke      # 3 CockroachDB regions on a local k3d cluster, no GCP account
npm run bootstrap  # once: management cluster + Config Connector
npm run deploy     # chant run crdb-deploy
npm run teardown   # chant run crdb-teardown
```

## What runs the deploy

Three Ops, in `ops/`. Together they replace a 205-line shell script.

| Op | What it does | Where it runs |
|---|---|---|
| `crdb-deploy` | 16 phases: network, three clusters, readiness, certificates, the operator, workloads, discovery, init, topology. Seven phases fan out per region. | local executor — no Temporal server |
| `crdb-publish-ui` | Holds for DNS delegation at your registrar, then verifies all three UIs answer. | Temporal (`--temporal`) |
| `crdb-teardown` | Unwinds inside out: workloads, volumes, clusters, network, residue. | local executor |
| `crdb-k3d-smoke` | The local proof — see [Local verification](#local-verification-no-cloud-account). | local executor |

`chant run crdb-deploy` reports the phase it is in, retries a failed step under a profile chosen for how long that step should take, and on failure runs a Diagnose phase that dumps cluster, pod and CockroachDB state next to the phase that failed.

The gate is in `crdb-publish-ui` rather than in the deploy, deliberately. Delegating three subdomains at a registrar is the one step nobody can automate from inside GCP, and Google will not issue the managed certificates until the names resolve — but the database does not depend on any of it. A gate anywhere in an Op makes the whole Op refuse to run on the local executor, so putting it in the deploy would mean requiring a Temporal server to bring up a database cluster.

```bash
chant run crdb-publish-ui --temporal
# ... create the NS records the Nameservers phase printed ...
chant run signal crdb-publish-ui gate-dns-delegation
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    GCP VPC: crdb-multi-region                    │
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │  GKE East    │     │  GKE Central │     │  GKE West    │    │
│  │  us-east4    │◄───►│  us-central1 │◄───►│  us-west1    │    │
│  │  nodes:      │     │  nodes:      │     │  nodes:      │    │
│  │  10.1.0.0/20 │     │  10.2.0.0/20 │     │  10.3.0.0/20 │    │
│  │  pods (GKE): │     │  pods (GKE): │     │  pods (GKE): │    │
│  │  10.64.0.0/14│     │ 10.128.0.0/14│     │  10.84.0.0/14│    │
│  │  crdb-east   │     │  crdb-central│     │  crdb-west   │    │
│  │  (3 nodes)   │     │  (3 nodes)   │     │  (3 nodes)   │    │
│  │  Prometheus  │     │  Prometheus  │     │  Prometheus  │    │
│  └──────┬───────┘     └──────┬───────┘     └──────┬───────┘    │
│         │                    │                    │              │
│         └────────────────────┴────────────────────┘              │
│              Native VPC routing (~25-45ms)                       │
│                                                                  │
│  Cloud Armor (crdb-ui-waf) ── WAF + rate limiting + DDoS        │
│  KMS (crdb-encryption) ────── encryption at rest (90d rotation) │
│  GCS (crdb-backups) ───────── daily backups with lifecycle      │
│  Secret Manager ───────────── TLS certs → ESO → K8s Secrets     │
└──────────────────────────────────────────────────────────────────┘

Cloud DNS private zone: crdb.internal
  cockroachdb-{0,1,2}.east.crdb.internal    → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.central.crdb.internal → pod IPs (ExternalDNS)
  cockroachdb-{0,1,2}.west.crdb.internal    → pod IPs (ExternalDNS)
```

### Cross-cluster discovery with ExternalDNS

Each GKE cluster runs its own kube-dns, which resolves `*.svc.cluster.local` only within that cluster. CockroachDB needs all 9 nodes to find each other across 3 separate clusters.

A Cloud DNS private zone (`crdb.internal`) is shared by all three clusters through the global VPC. ExternalDNS in each cluster watches the CockroachDB headless service and registers pod IPs as A records:

```
ExternalDNS (east cluster)
  watches: headless Service annotated external-dns.alpha.kubernetes.io/hostname=east.crdb.internal
  creates: cockroachdb-0.east.crdb.internal → 10.1.x.x (pod IP)
           cockroachdb-1.east.crdb.internal → 10.1.x.y
           cockroachdb-2.east.crdb.internal → 10.1.x.z

ExternalDNS (central cluster)  →  cockroachdb-{0,1,2}.central.crdb.internal
ExternalDNS (west cluster)     →  cockroachdb-{0,1,2}.west.crdb.internal
```

CockroachDB's `--join` references those names. When a pod restarts with a new IP, ExternalDNS updates the record.

**Advertise address.** Each node has to advertise a name the *other two clusters* can resolve. `$(hostname -f)` returns `cockroachdb-0.cockroachdb.crdb-east.svc.cluster.local`, which resolves in east and nowhere else, so gossip never converges — nodes come up healthy, never find each other, and sit there. `CockroachDbRegionStack`'s `advertiseHostDomain` sets the per-pod advertise address to `${HOSTNAME}.${advertiseHostDomain}`, e.g. `cockroachdb-0.east.crdb.internal`.

This is asserted, not just documented: see the `every node advertises a name the other two regions can resolve` test in `examples/examples.test.ts`.

**Workload Identity chain** for ExternalDNS — no long-lived keys:

```
GCP ServiceAccount (gke-crdb-{region}-dns)
  └── IAMPolicyMember: roles/dns.admin
  └── IAMPolicyMember: roles/iam.workloadIdentityUser
        └── binds K8s SA "external-dns-sa" in kube-system
              └── the ExternalDNS Deployment runs as it
```

### Multi-region topology

- **`REGIONAL BY ROW`** — each row carries its home region in a `crdb_internal_region` column. A read from the home region is served by a local leaseholder.
- **`SURVIVE REGION FAILURE`** — the cluster keeps serving when a whole region goes. Only legal once all three regions are added, because it needs replicas in all three.
- **Locality flags** — every node starts with `--locality=cloud=gcp,region=us-east4` (or central/west). These must match the names used in `ALTER DATABASE ... ADD REGION`.

`scripts/configure-regions.sh` is the deploy's Topology phase: primary region, two secondaries, survival goal, and a demo `orders` table.

## Where values come from

Three values vary per deployment, and all three are declared as build parameters in `chant.config.ts` rather than read from `process.env` in source:

| Parameter | Env mapping | What it is |
|---|---|---|
| `projectId` | `GCP_PROJECT_ID` | the project the whole estate is created in |
| `projectNumber` | `GCP_PROJECT_NUMBER` | Google-managed service agents are addressed by number, not id — the GCS agent that uses the CMEK key |
| `domain` | `CRDB_DOMAIN` | base domain for the UIs: `east.<domain>`, `central.<domain>`, `west.<domain>` |

```bash
cp .env.example .env      # then edit
set -a && source .env && set +a
```

or per invocation, which is what CI should do:

```bash
chant build src/shared --lexicon gcp --param projectId=my-project
```

Every parameter has a placeholder default, so the example builds with none of them set. It just does not deploy. `gcloud projects describe $GCP_PROJECT_ID --format='value(projectNumber)'` gets you the second one.

### Ownership

`chant.config.ts` sets `ownership: { stack: "crdb-multi-region" }`, so every emitted resource carries `chant.intentius.io/stack: crdb-multi-region` alongside `app.kubernetes.io/managed-by: chant`. That marker is what lets a later prune tell this estate's resources from anything else in the project — ownership lives on the live resource, not in a state file chant hosts. It also makes the observe position work:

```bash
npm run diff       # chant lifecycle diff prod --live
```

## Local verification (no cloud account)

```bash
npm run smoke      # chant run crdb-k3d-smoke
```

Three CockroachDB regions in three namespaces of one k3d cluster: a shared CA, three secure nodes, one logical cluster, three regions known to SQL, and a `REGIONAL BY ROW` table that takes a write. About a minute once the CockroachDB image is cached; the first run pulls it. Needs `k3d`, `kubectl` and `docker`, and no credentials of any kind. The cluster is deleted whether the run passes or fails.

The cluster's own shape is declared too — `k3d/src/k3d-cluster.ts` builds to the `k3d.io/v1alpha5` config `k3d cluster create --config` consumes, so the declaration and what gets created cannot drift.

**What it covers:** the manifests apply; a secure cluster forms on a shared CA across three localities; `advertiseHostDomain` works; exactly one region initialises; multi-region SQL works.

**What it does not, and could not without three clusters:** cross-*cluster* gossip, ExternalDNS against Cloud DNS, Workload Identity, External Secrets against Secret Manager, GCE Ingress, Cloud Armor, and NetworkPolicy enforcement — k3s runs flannel, which ignores NetworkPolicy entirely. `k3d/src/config.ts` says the same thing next to the code.

Build and lint on their own, without a cluster:

```bash
npm install
npm run build     # 8 artifacts in dist/
npm run lint      # 4 stacks
```

## Prerequisites

### Quota

Config Connector creates each GKE cluster with a default node pool it cannot suppress, alongside the managed pool. The deploy's Reclaim quota phase deletes the default pools once the managed ones are ready, but peak usage is what your quota has to cover: **6 + 3×18 = 60 vCPU**, settling to 42. Ensure `CPUS_ALL_REGIONS` is at least **64**.

```bash
gcloud compute regions list --project "${GCP_PROJECT_ID}" \
  --format="table(name, quotas.filter('metric:CPUS').map().extract('limit','usage').flatten())"
```

### Tools

| Tool | Needed for |
|---|---|
| `gcloud` | the deploy, authenticated (`gcloud auth login`) |
| `kubectl` | the deploy |
| `docker` | cert generation |
| `helm` | **`chant build`**, not the deploy — `platform/eso.ts` renders the ESO chart at synth time |
| `k3d` | the local smoke test only |
| a domain you control | the UIs. The database does not need it. |

## Deploy

```bash
cp .env.example .env && $EDITOR .env
set -a && source .env && set +a

npm install
npm run bootstrap    # once — management cluster + Config Connector
npm run deploy       # chant run crdb-deploy
```

The management cluster is created imperatively by `scripts/bootstrap.sh`, because something has to run Config Connector before Config Connector can create anything. Everything after that is declared.

Then, when you are ready to expose the UIs:

```bash
chant run crdb-publish-ui --temporal
```

Its first phase prints the nameservers for each regional zone. Create NS records at your registrar:

```
east.<your-domain>     →  NS  (the nameservers printed for gke-crdb-east-zone)
central.<your-domain>  →  NS  (gke-crdb-central-zone)
west.<your-domain>     →  NS  (gke-crdb-west-zone)
```

Check with `dig NS "east.${CRDB_DOMAIN}"`, then send the signal. The Op waits up to 72 hours, durably — a worker restart does not lose it.

### External Secrets Operator

Pinned in source, at `platform/eso.ts`:

```ts
export const ESO_CHART_VERSION = "2.9.0";
```

`HelmRender` runs `helm template` at build time and emits the operator into `dist/eso.yaml` — 44 resources, 25 of them CRDs — so it is applied like any other manifest rather than installed by a `helm upgrade --install` of whatever the repo currently serves. The render is cached under `~/.chant/helm-renders`, keyed by repo, chart, version and values, so only the first build reaches the network.

To bump it: read the upstream release notes, change the line, `npm run build:platform`, re-apply. `helm search repo external-secrets/external-secrets --versions` lists what is available.

## Verify

```bash
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach node status --certs-dir=/cockroach/cockroach-client-certs
```

**The certs directory matters.** `/cockroach/cockroach-certs` holds `ca.crt`, `node.crt` and `node.key` and no client certificate, so `cockroach sql` and `cockroach node status` against it fall through to password auth and fail with `password authentication failed for user root` — which reads like a credentials problem and is not. East mounts the client certs separately at `/cockroach/cockroach-client-certs`; central and west do not.

```bash
# multi-region topology
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-client-certs -e \
  "SHOW REGIONS FROM DATABASE defaultdb; SHOW SURVIVAL GOAL FOR DATABASE defaultdb;"

# the demo table, by home region
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-client-certs -e \
  "SELECT region, count(*) FROM orders GROUP BY region;"
```

### First DB Console login

`root` authenticates by certificate and cannot log in through the browser. Create a password user:

```bash
kubectl --context east exec cockroachdb-0 -n crdb-east -- \
  /cockroach/cockroach sql --certs-dir=/cockroach/cockroach-client-certs -e \
  "CREATE USER dbadmin WITH PASSWORD 'pick-something-long'; GRANT admin TO dbadmin;"
```

Not `admin` — that is a built-in role and `GRANT admin TO admin` fails. Avoid `!` in the password: bash treats it as history expansion inside double quotes and silently corrupts it before `CREATE USER` runs.

## Troubleshooting

### Pods stay `0/1 Running`, logs show `dial tcp <pod-ip>:26257: i/o timeout`

Three causes, in the order they are worth checking:

1. **GKE pod CIDRs missing.** GKE assigns pods addresses from secondary ranges that are *not* the declared pod subnets. Both the VPC firewall and every NetworkPolicy need them. They are one list — `GKE_POD_CIDRS` in `src/shared/config.ts`, consumed by `shared/infra.ts` and by every region's `allowCidrs`. Find the real ranges with `gcloud compute networks subnets describe <name> --region=<region>`.
2. **Join backoff.** After roughly 60 failed join attempts CockroachDB backs off for a long time. Once the network is fixed, delete the pods to force an immediate retry.
3. **Cluster-local advertise address.** If `cockroach node status` shows `...svc.cluster.local` in the address column instead of `...crdb.internal`, `advertiseHostDomain` is not set.

### `password authentication failed for user root`

Wrong certs directory — see [Verify](#verify).

### GCE backend UNHEALTHY

1. The `cloud.google.com/backend-config` annotation must be on the **Service**, not the Ingress. `CockroachDbRegionStack` puts it there.
2. The GCE health-check prober ranges (`35.191.0.0/16`, `130.211.0.0/22`) must be in the NetworkPolicy — `HEALTH_CHECK_CIDRS` in `src/shared/config.ts`.
3. `kubectl get backendconfig -n crdb-east` — the resource has to exist in the namespace.

### `curl: (47) Maximum (50) redirects followed`

The load balancer is forwarding plain HTTP to CockroachDB, which is TLS-only and answers with a 301 back to HTTPS. Fixed by `cloud.google.com/app-protocols: '{"http":"HTTPS"}'` on the Service, which the region stack sets.

### `429 Too Many Requests` on the UI

The DB Console polls metrics continuously and makes many parallel calls. Anything under ~2000 req/min triggers bans during normal use; the Cloud Armor policy in `src/shared/platform.ts` allows 3000/min with a 1-minute ban.

### ManagedCertificate stuck in `Provisioning`

Needs DNS delegation complete *and* the backend HEALTHY before ACME HTTP-01 can finish. Allow 15-20 minutes. `crdb-publish-ui`'s Certificates phase waits up to 45.

### ExternalDNS is not registering pod IPs

- `googleapi: Error 403: Forbidden` — Workload Identity binding missing, or the wrong project.
- `no endpoints found` — the headless service is missing its annotation, or no pod is ready.
- `zone not found` — the shared stack was not applied.

## Teardown

```bash
npm run teardown     # chant run crdb-teardown
```

Order is the content of that Op: workloads before clusters (or the regional load balancers are orphaned in GCP with nothing left to reconcile them), clusters before the VPC (or the network delete blocks on dependencies until it times out). Every step tolerates an already-absent resource, so it is safe to re-run after a partial teardown — which, after a failed deploy, is the usual case.

The last phase cleans up what Config Connector does not own: the backup bucket's objects, the Secret Manager versions, the management cluster, and its service account.

If you delegated DNS at your registrar, remove the NS records — they now point at deleted zones.

## Cost

~$1.90/hr (~$46/day). Tear it down after testing.

| Component | Per region | 3 regions |
|---|---|---|
| GKE control plane | $0.10/hr | $0.30/hr |
| 3× e2-standard-4 nodes | ~$0.40/hr | ~$1.20/hr |
| Storage (3× 100Gi pd-ssd) | ~$0.05/hr | ~$0.15/hr |
| Cloud NAT | ~$0.05/hr | ~$0.15/hr |
| KMS + Secret Manager | — | ~$0.01/hr |
| GCS backup bucket | — | ~$0.01/hr |
| Cloud Armor | — | ~$0.08/hr |

No VPN gateway: GCP's VPC routes between regions natively.

## Project structure

```
chant.config.ts               # lexicons, ownership marker, build parameters
src/
├── shared/                   → dist/shared-infra.yaml     (31 resources)
│   ├── config.ts             # CIDRs, node addresses, names every stack refers to
│   ├── infra.ts              # MultiRegionVpc + GKE-pod firewall + private DNS zone
│   ├── platform.ts           # KMS, GCS backups, Cloud Armor
│   ├── secrets.ts            # 5 Secret Manager entries for the TLS material
│   └── iam.ts                # External Secrets identity + 3 WI bindings
├── east/                     → dist/east-infra.yaml (10) + dist/east-k8s.yaml (30)
│   ├── config.ts             # us-east4: machine type, master CIDR, domains
│   ├── infra.ts              # GkeCrdbRegion
│   └── k8s.ts                # CockroachDbRegionStack
├── central/                  # same two files              (10 + 29)
└── west/                     # same two files              (10 + 29)
platform/
└── eso.ts                    → dist/eso.yaml               (44, HelmRender)
ops/
├── deploy.op.ts              # crdb-deploy
├── publish-ui.op.ts          # crdb-publish-ui  (the gate)
├── teardown.op.ts            # crdb-teardown
└── k3d-smoke.op.ts           # crdb-k3d-smoke
k3d/
├── src/                      # the smoke cluster + three local regions
├── certs.sh                  # shared CA into three namespaces
└── verify.sh                 # 3 live nodes, 3 regions, a regional-by-row write
scripts/
├── bootstrap.sh              # management cluster + Config Connector (once)
├── kube-contexts.sh          # credentials for mgmt + east/central/west
├── delete-default-pools.sh   # reclaim the CPU quota GKE takes
├── generate-certs.sh         # one CA, one node cert with all 9 SANs, one client cert
├── push-certs.sh             # cert versions into Secret Manager
├── wait-dns.sh               # block until ExternalDNS has registered
├── init-cluster.sh           # wait for the init Job, then the backup schedule
├── configure-regions.sh      # primary region, secondaries, survival goal, demo table
├── teardown-residue.sh       # what Config Connector does not own
└── e2e-test.sh               # post-deploy resource validation
```

**193 resources deployed** — 31 shared, 44 for the operator, and 39-40 per region.

Everything under `src/` folds: every file reduces to data with no module execution.

## What the composites do

Three of them carry most of this example. Two were extracted from an earlier version of it.

| Composite | Lexicon | Replaces |
|---|---|---|
| `MultiRegionVpc` | gcp | VPC, node + pod subnets per region, a router and NAT per region, allow-internal firewall |
| `GkeCrdbRegion` | gcp | GKE cluster + node pools, public DNS zone, ExternalDNS GSA with WI + `dns.admin`, CockroachDB GSA with WI + bucket access |
| `CockroachDbRegionStack` | k8s | namespace with quota/limits/default-deny, `pd-ssd` StorageClass, the CockroachDB StatefulSet + services + RBAC + PDB, ClusterSecretStore + two ExternalSecrets, managed cert + FrontendConfig + GCE Ingress, Cloud Armor BackendConfig, ExternalDNS, Prometheus |

A gap in any of them is a lexicon fix, not a workaround here.

## TLS

- **Inter-node and client** — one self-signed CA via `cockroach cert`, one node certificate whose SANs cover all nine nodes across all three clusters (both `*.{region}.crdb.internal` and cluster-local names), one root client certificate. Generated by `scripts/generate-certs.sh`, stored as Secret Manager versions, synced into each cluster by External Secrets.
- **Why not per-region cert-gen** — `CockroachDbCluster` can generate its own CA, and every region doing so means three CAs and `certificate signed by unknown authority` between them. The region stacks set `skipCertGen`.
- **The UI** — GCE Ingress with a GKE ManagedCertificate (Google-managed, ACME HTTP-01, auto-renewed) and a FrontendConfig that redirects HTTP to HTTPS. The load balancer speaks HTTPS to the backend because CockroachDB accepts nothing else.

## Security

1. **Pod Security Standards** — every namespace enforces `baseline`, warns and audits at `restricted`.
2. **Default-deny NetworkPolicy** per namespace, with one explicit allow for 26257 and 8080 from the subnet CIDRs, the GKE-allocated pod CIDRs, and the health-check probers. All three lists are needed: the first two differ (node VMs vs pod alias ranges) and cross-cluster gossip breaks without both; the third is what keeps the GCE backend from staying UNHEALTHY.
3. **Private DNS for discovery** — pod addresses live in a zone visible only inside the VPC.
4. **mTLS everywhere** — node-to-node and client-to-node.
5. **CMEK at rest** — Cloud KMS, 90-day rotation, on the backup bucket.
6. **Native VPC routing** — cross-region traffic stays on Google's backbone.
7. **Workload Identity** — no long-lived credentials in any cluster.
8. **Secret Manager + External Secrets** — certificates are never in git and never hand-created after the first push.
9. **Cloud Armor** — rate limiting, XSS and SQLi rules, L7 DDoS defense.
10. **Quotas and LimitRange** per namespace.
11. **PodDisruptionBudget** — 2 of 3 pods stay up through node maintenance.
12. **Daily backups** to GCS, nearline at 30 days, deleted at 90.
13. **Prometheus** per region, scraping `/_status/vars`.
14. **Ownership marker** on every resource, so a prune can be precise without a state file.

## Standalone usage

Outside the monorepo:

```bash
cp package.standalone.json package.json
npm install
cp .env.example .env      # fill in, then source it
npm run bootstrap
npm run deploy
```

## Related examples

- **[getting-started](../getting-started/)** — chant itself, level by level
- **[k8s-gke-microservice](../k8s-gke-microservice/)** — single-region GKE with GCE ingress and Workload Identity
- **[k8s-eks-microservice](../k8s-eks-microservice/)** — EKS with ALB ingress and IRSA
- **[k8s-aks-microservice](../k8s-aks-microservice/)** — AKS with AGIC ingress and Workload Identity
- **[gitlab-cells-single-region-gke](../gitlab-cells-single-region-gke/)** — multi-cell GitLab on GKE with Cloud SQL, Redis and GCS
- **[temporal-crdb-deploy](../temporal-crdb-deploy/)** — the same estate driven by a hand-written Temporal workflow instead of Ops
