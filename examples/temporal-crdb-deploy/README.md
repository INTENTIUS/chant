# temporal-crdb-deploy

A 9-node CockroachDB cluster across 3 GCP regions, orchestrated by a **Temporal workflow**.

The chant sources (`src/`) declare all infrastructure and K8s resources. The Temporal workflow in `temporal/` drives the 13-phase deployment: build → GCP infra → DNS delegation gate → K8s → CockroachDB init → backup.

---

## Agent walkthrough

After `npm install`, six skills are loaded automatically:

| Skill | Source | Purpose |
|---|---|---|
| `temporal-crdb-deploy` | this example | Primary: Temporal workflow phases, monitoring, signals, troubleshooting |
| `chant-gke` | `@intentius/chant-lexicon-gcp` | Management cluster bootstrap, Config Connector lifecycle |
| `chant-gcp` | `@intentius/chant-lexicon-gcp` | GCP infra manifests, Secret Manager |
| `chant-k8s` | `@intentius/chant-lexicon-k8s` | K8s manifest deployment |
| `chant-k8s-gke` | `@intentius/chant-lexicon-k8s` | CockroachDbCluster, GkeExternalDnsAgent composites |
| `chant-k8s-patterns` | `@intentius/chant-lexicon-k8s` | Multi-region DNS, External Secrets, cert distribution |

To deploy with an agent:

```
Deploy the temporal-crdb-deploy example.
My GCP project is my-project-id. My domain is crdb.mycompany.com.
My Temporal Cloud namespace is myns.a2dd6, address myns.a2dd6.tmprl.cloud:7233.
```

The agent will bootstrap the management cluster, configure `.env`, start the worker, launch the workflow, and guide you through the one manual step (DNS delegation at phase 4).

---

## What is Temporal?

Temporal is a durable workflow engine. You write workflows in TypeScript — Temporal executes them reliably, storing state in the cloud. If the process crashes mid-workflow, the workflow resumes from its last checkpoint when the process restarts. Your machine runs a **worker** that executes the actual shell commands; Temporal delivers tasks to it and tracks results.

## What Temporal adds

The original `deploy.sh` is a 200-line bash script with:

- Polling loops with no max attempt count or backoff (`for i in $(seq 1 60); do ... sleep 15; done`)
- No resume: if it fails at phase 7, you re-run from scratch
- No visibility: `grep`-ing logs to see what phase you're in
- A comment saying "configure your registrar manually" with no pause mechanism

The Temporal workflow replaces all of this with:

| Problem | Temporal solution |
|---|---|
| Infinite polling loops | Activity heartbeats — Temporal kills the activity if it goes silent |
| No retry backoff | Per-activity retry config with `initialInterval` + `backoffCoefficient` |
| No resume | Workflow state is durable; restart the worker, the workflow continues |
| Sequential regional deploys | `Promise.all` — all 3 regions deploy in parallel |
| "configure registrar manually" | `condition()` — workflow pauses until unblocked |
| No feedback on DNS propagation | `defineUpdate('validate-dns')` — returns which zones are still pending |
| "is delegation done yet?" polling | `waitForDnsDelegation` activity auto-detects via `dig`, races the signal |
| All workflows look the same in the UI | Search attributes `GcpProject` + `CrdbDomain` — filter by project |
| Grepping logs for phase | `defineQuery('current-phase')` — query it from the CLI or UI |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Temporal Cloud (free tier)                                 │
│                                                             │
│  Workflow: deployMultiRegionCRDB                            │
│  ├── buildStacks()                                          │
│  ├── applySharedInfra()                                     │
│  ├── Promise.all([applyRegionalInfra × 3])  ← heartbeats   │
│  ├── race: waitForDnsDelegation ‖ signal    ← auto+manual   │
│  ├── configureKubectl()                                     │
│  ├── generateAndDistributeCerts()                           │
│  ├── Promise.all([installESO × 3])                          │
│  ├── pushSecretsToSecretManager()                           │
│  ├── Promise.all([applyK8sManifests × 3])                   │
│  ├── waitForExternalDNS()                   ← heartbeats   │
│  ├── Promise.all([waitForStatefulSets × 3]) ← heartbeats   │
│  ├── initializeCockroachDB()                                │
│  ├── configureMultiRegion()                                 │
│  └── setupBackupSchedule()                                  │
│                                                             │
│  Worker (your machine) ───────────────────────────────┐    │
│  │  activities/infra.ts      kubectl apply, gcloud     │    │
│  │  activities/kubernetes.ts  rollout status, context  │    │
│  │  activities/cockroachdb.ts  init, configure-regions │    │
│  │  activities/certs.ts       helm, gcloud secrets     │    │
└──┴───────────────────────────────────────────────────────-─-┘
```

The worker runs on your machine (or CI). Temporal Cloud stores the workflow state. If the worker crashes, restart it and the workflow picks up exactly where it left off.

---

## Prerequisites

Same as `cockroachdb-multi-region-gke`:

- Node.js 20+
- `gcloud` CLI (authenticated, project set)
- `kubectl`, `helm`, `docker` (Docker must be running before starting the worker)

Plus:

- **Temporal Cloud account** — [sign up free at cloud.temporal.io](https://cloud.temporal.io) (no credit card, 5 GB storage/month included)

All signals, queries, and updates are self-contained via `npm run temporal:*` — no Temporal CLI binary is required. If you have it installed (`brew install temporal`), you can use it as an alternative for ad-hoc operations.

---

## Setup

### 1. Bootstrap the management cluster (one-time)

```bash
npm run bootstrap
```

Creates a 2-node `e2-standard-2` GKE management cluster with Config Connector installed. All GCP infra is applied via `kubectl apply`. See `cockroachdb-multi-region-gke` README for the full walkthrough.

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# GCP
GCP_PROJECT_ID=my-project-id
GCP_PROJECT_NUMBER=123456789
CRDB_DOMAIN=crdb.mycompany.com

# Temporal Cloud
TEMPORAL_ADDRESS=myns.a2dd6.tmprl.cloud:7233   # Settings → Namespaces → gRPC endpoint
TEMPORAL_NAMESPACE=myns.a2dd6                  # same page, namespace name
TEMPORAL_API_KEY=eyJ...                         # Settings → API Keys → Create
```

Source it:

```bash
set -a && source .env && set +a
```

### 3. (One-time) Register custom search attributes in Temporal Cloud

In the Temporal Cloud UI: **Settings → Search Attributes → Add**

| Name | Type |
|---|---|
| `GcpProject` | Text |
| `CrdbDomain` | Text |

This lets you filter workflows in the UI by project or domain. Skip if you don't need UI filtering.

### 4. Install dependencies

This is a Bun workspace — install from the monorepo root:

```bash
# From the repo root:
cd ../..
bun install
cd examples/temporal-crdb-deploy
```

---

## Quick start

You need two terminals. Make sure Docker Desktop is running before starting the worker.

**Terminal 1 — start the worker:**

```bash
npm run temporal:worker
```

You'll see:

```
Connecting to Temporal Cloud: myns.a2dd6.tmprl.cloud:7233 (namespace: myns.a2dd6)
Worker ready — polling task queue: crdb-deploy
```

**Terminal 2 — start the deployment:**

```bash
npm run temporal:deploy
```

Output:

```
Workflow started: crdb-deploy-my-project-id
View in Temporal Cloud UI: https://cloud.temporal.io

Run to check progress:
  npm run temporal:query -- current-phase
```

The workflow ID is `crdb-deploy-{GCP_PROJECT_ID}`. Running `temporal:deploy` again while the workflow is running is a no-op — Temporal deduplicates by workflow ID.

---

## Watching progress

**Check the current phase from the terminal:**

```bash
npm run temporal:query -- current-phase
# → Current phase: APPLY_REGIONAL_INFRA
```

**Temporal Cloud UI:**

Navigate to: **cloud.temporal.io → Namespaces → your-namespace → Workflows → `crdb-deploy-my-project-id`**

- **Events tab**: each activity as a row with start/end time and retry count. `ActivityTaskStarted` events include the heartbeat payload — e.g. `{ "phase": "waiting for GKE Ready", "region": "east", "attempt": 12 }`.
- **Query tab**: run `current-phase` or `nameservers` queries without touching the terminal.
- **Retry count**: count `ActivityTaskScheduled` entries for a given activity.
- **Signal history**: `WorkflowExecutionSignaled` events show when signals were received.
- **Filter by project**: if you registered search attributes, filter by `GcpProject = "my-project-id"` to find all runs.

---

## DNS delegation step

After phase 3 (regional infra), the workflow pauses at `WAIT_DNS_DELEGATION`. The public Cloud DNS zones are up, but you need to delegate the subdomains at your registrar before ingress certificates resolve. The CockroachDB cluster itself is healthy — only the Admin UI access depends on public DNS.

### Auto-detection

The workflow runs `waitForDnsDelegation` in the background, polling `dig +short NS` for each zone every 30 s for up to 45 minutes. Once all three zones have NS records, the workflow unblocks automatically — no command needed.

### Check delegation status at any time

`validate-dns` is an **Update** — it runs a live `dig` check and returns which zones are still pending:

```bash
npm run temporal:update -- validate-dns
# → DNS delegation pending. Missing zones: west
# → Wait for NS records to propagate, then retry
```

Run it repeatedly while you wait for propagation. Once all zones show up:

```
# → DNS delegation confirmed for all zones.
# → Run: npm run temporal:signal -- dns-configured
```

### Manual override

If auto-detection doesn't fire (e.g. `dig` isn't installed on the worker host, or you want to skip the 30 s polling interval), send the signal directly:

```bash
npm run temporal:signal -- dns-configured
# → Signal sent: dns-configured
# → Workflow will now proceed to configure kubectl and generate certs.
```

### Getting nameservers

The workflow fetches nameservers from Cloud DNS automatically:

```bash
npm run temporal:query -- nameservers
# east.crdb.mycompany.com: ns-cloud-b1.googledomains.com, ns-cloud-b2.googledomains.com, ...
# central.crdb.mycompany.com: ns-cloud-c1.googledomains.com, ...
# west.crdb.mycompany.com: ns-cloud-d1.googledomains.com, ...
```

Add these as NS records at your registrar — one per subdomain. The specific nameserver pool (b1-b4, c1-c4, d1-d4) varies per deployment; use the values from the query above.

---

## GKE pod CIDRs

GKE assigns secondary IP ranges for pods at cluster-creation time. These differ from the VPC subnet CIDRs in `src/shared/config.ts` and must match. After your first deployment, check the actual values:

```bash
for region in east central west; do
  cluster="gke-crdb-${region}"
  gke_region=$(case $region in east) echo us-east4;; central) echo us-central1;; west) echo us-west1;; esac)
  echo "$region: $(gcloud container clusters describe $cluster --region $gke_region --format='value(clusterIpv4Cidr)')"
done
```

Update `GKE_POD_CIDRS` in `src/shared/config.ts` if they differ from the defaults. This flows to both the `crdb-multi-region-allow-gke-pods` GCP firewall rule and the per-region K8s NetworkPolicies.

---

## If it fails

**Docker not running**: The `generateAndDistributeCerts` activity checks Docker at startup and throws a clear error. Start Docker Desktop, then the activity retries automatically.

**Worker crash**: Run `npm run temporal:worker` again. Temporal re-delivers the in-progress activity and the workflow continues. Do not re-run `temporal:deploy`.

**Activity failure**: Temporal retries automatically (3 attempts, exponential backoff). Fix the underlying issue (GCP quota, missing permission) and the activity retries. The retry count is visible in the UI under the Events tab.

**Workflow exhausted retries (Failed state)**: Use the Temporal CLI to reset to a specific event:

```bash
# Find the last WorkflowTaskCompleted before the failed activity
temporal workflow show --workflow-id crdb-deploy-{project-id} \
  --address $TEMPORAL_ADDRESS --namespace $TEMPORAL_NAMESPACE --api-key $TEMPORAL_API_KEY

# Reset to that event (re-runs from there without repeating earlier phases)
temporal workflow reset --workflow-id crdb-deploy-{project-id} \
  --run-id {run-id} --event-id {event-id} \
  --reason "fixed the underlying issue" \
  --address $TEMPORAL_ADDRESS --namespace $TEMPORAL_NAMESPACE --api-key $TEMPORAL_API_KEY
```

The Temporal UI shows all runs for a workflow ID — multiple entries are expected if you reset. The most recent is the active one.

---

## Teardown

```bash
npm run teardown
```

Same teardown script as `cockroachdb-multi-region-gke`.

---

## Cost estimate

GCP: ~$1.90/hr (~$46/day) for all three GKE clusters. Teardown after testing.

Temporal Cloud free tier: 5 GB storage/month, sufficient for this workflow.

---

## Temporal patterns reference

### Activity heartbeat

`applyRegionalInfra` heartbeats every ~15 s while polling for GKE Ready status. With `heartbeatTimeout: '60s'`, Temporal marks the activity failed if it goes silent — replacing bash's infinite loops with no timeout.

```typescript
for (let attempt = 1; attempt <= 60; attempt++) {
  ctx.heartbeat({ phase: 'waiting for GKE Ready', region, attempt });
  // ... check status ...
  await sleep(15_000);
}
```

### Signal — human-in-the-loop

```typescript
setHandler(dnsConfiguredSignal, () => { dnsConfigured = true; });
await condition(() => dnsConfigured, '48h');
```

The workflow sleeps (zero CPU) until the signal arrives. Sent with `npm run temporal:signal -- dns-configured`.

### Auto-DNS detection (parallel race)

`waitForDnsDelegation` runs concurrently with `condition()`. It polls `dig +short NS` every 30 s for up to 45 minutes, heartbeating throughout. Whichever fires first — the activity or the signal — unblocks the workflow.

```typescript
void waitForDnsDelegation(params).then(() => { dnsConfigured = true; }).catch(() => {});
setHandler(dnsConfiguredSignal, () => { dnsConfigured = true; });
await condition(() => dnsConfigured, '48h');
```

### Update — bidirectional RPC

Unlike signals (fire-and-forget), Updates return a value to the caller:

```typescript
export const validateDnsUpdate = defineUpdate<{ ready: boolean; missing: string[] }>('validate-dns');
setHandler(validateDnsUpdate, async () => checkDnsZones(params.crdbDomain));
```

`checkDnsZones` runs as a **local activity** (`proxyLocalActivities`) so it can execute `dig` outside the deterministic workflow sandbox.

```bash
npm run temporal:update -- validate-dns
# → { ready: false, missing: ["west"] }
```

### Query — inspect running state

```typescript
setHandler(currentPhaseQuery, () => currentPhase);
```

```bash
npm run temporal:query -- current-phase
```

### Parallel activities

```typescript
await Promise.all([
  applyRegionalInfra(params, 'east'),
  applyRegionalInfra(params, 'central'),
  applyRegionalInfra(params, 'west'),
]);
```

All three activities run simultaneously. The original bash script ran them sequentially.

### Search attributes

```typescript
searchAttributes: {
  GcpProject: [gcpProjectId],
  CrdbDomain: [crdbDomain],
}
```

Filter in Temporal Cloud UI: `GcpProject = "my-project"`. Requires one-time registration in Settings → Search Attributes.

### Workflow ID deduplication

Workflow ID `crdb-deploy-{gcpProjectId}` is deterministic. Starting the workflow twice with the same ID returns a handle to the existing workflow — never creates a duplicate.
