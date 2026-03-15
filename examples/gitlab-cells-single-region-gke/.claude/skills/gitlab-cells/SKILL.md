---
skill: gitlab-cells
description: Operate and extend a GitLab Cells deployment on GKE — local routing smoke test (k3d), routing, per-cell runners, and health monitoring
user-invocable: true
---

# GitLab Cells Operations

## Overview

This example demonstrates GitLab Cells architecture on GKE, modelling the same concerns as GitLab's own Cells 1.0 / 1.5 roadmap:

| Roadmap item | This example |
|---|---|
| Cloudflare Worker HTTP router | Cell Router Deployment (`src/system/cell-router.ts`) |
| session_token.json / routable_token.json routing spec | `src/system/routing-rules.ts` |
| Cell-local CI runners with routable token format | Per-cell runner in `src/cell/factory.ts` |
| Topology Service (Cloud Spanner) | Topology Service on Cloud SQL (`src/system/topology-service.ts`) |
| Cell health signals to routing layer | PrometheusRule CRDs + ServiceMonitor (`src/system/monitoring.ts`) |
| OrgMover | `migrate-org` pipeline job (manual) |

All resources derive from the `cells[]` array in `src/config.ts`. Adding a cell entry automatically fans out GCP infra, K8s resources, runner registration, and health monitoring.

---

## Local Routing Smoke Test (k3d)

Validates cell-router + topology-service routing logic locally in ~3 minutes. No GCP, no GitLab chart, no Cloud SQL required. Run this before a full GKE deployment to catch routing bugs early.

### Prerequisites

```bash
# Required tools (in addition to npm):
k3d    # https://k3d.io
docker # to build cell-router and topology-service images
```

### Run

```bash
npm run test:local
```

This script:
1. Builds `cell-router:local` and `topology-service:local` Docker images from source
2. Creates a k3d cluster (`gitlab-cells-smoke`) with a NodePort mapped to `localhost:8080`
3. Generates `k3d.yaml` via `npm run build:k3d` (same routing-rules ConfigMap as production)
4. Deploys the real cell-router + topology-service + nginx mock cells (alpha, beta)
5. Runs 6 routing assertions (see below)
6. Deletes the cluster on exit (pass or fail)

The topology-service runs without a database — it returns `alpha` as the default cell for all org-slug lookups, which is the production fallback behaviour.

### What it validates

| Test | Input | Expected cell |
|------|-------|---------------|
| Health endpoint | `GET /healthz` | 200 ok |
| Session cookie | `_gitlab_session=cell1_*` | alpha |
| Session cookie | `_gitlab_session=cell2_*` | beta |
| Routable token | `Bearer glrt-cell_1_*` | alpha |
| Routable token | `Bearer glrt-cell_2_*` | beta |
| Path fallback | `GET /some-org/project` (no cookie/token) | alpha (topology default) |

### Troubleshooting

**Cluster creation fails (`port already in use`)**
Port 8080 is taken. Either stop whatever is using it, or temporarily edit `HOST_PORT` in `scripts/k3d-smoke.sh` and `BASE_URL` in `scripts/k3d-validate.sh`.

**`npm run build:k3d` fails**
Ensure `npm install` has been run in the example root. The k3d sources import from `@intentius/chant-lexicon-k8s` which must be installed.

**Cell-router not reachable after 40s**
k3d NodePort didn't bind. Check `k3d cluster list` and `docker ps`. Try: `kubectl -n system get pods` and `kubectl -n system logs deploy/cell-router`.

**Routing test returns empty body**
The cell-router started but can't reach the mock cell. Check: `kubectl -n cell-alpha logs deploy/mock-gitlab-alpha` and `kubectl -n system logs deploy/cell-router`.

**Path fallback test returns wrong cell or empty**
The cell-router timed out calling topology-service. Check: `kubectl -n system logs deploy/topology-service` (expect "running without DB connection" warning — that's normal). Verify topology-service Service: `kubectl -n system get svc topology-service`.

### Inspecting the running cluster

```bash
# Check all pods are Running
kubectl get pods -A

# Inspect generated routing rules (same JSON as production)
kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.routing-rules\.json}' | jq .
kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.cell-registry\.json}' | jq .

# Check topology-service is up (will log DB connection failures — expected)
kubectl -n system logs deploy/topology-service

# Manual routing test against the NodePort
curl -s -H "Cookie: _gitlab_session=cell1_test" http://localhost:8080/
curl -s -H "Authorization: Bearer glrt-cell_2_test" http://localhost:8080/
curl -s http://localhost:8080/healthz

# Re-run only the validation (cluster must still be running)
bash scripts/k3d-validate.sh

# Delete the cluster manually if trap didn't fire
k3d cluster delete gitlab-cells-smoke
```

---

## Cell Router

### How routing rules work

Rules are evaluated in priority order (stateless first, topology last):

1. **SessionTokenRule** — extracts `cell${cellId}_` prefix from `_gitlab_session` cookie. No external call needed.
2. **RoutableTokenRule** — extracts `cell_${cellId}_` prefix from runner/API tokens matching `^glrt-cell_(\d+)_`. No external call needed.
3. **PathRule** — extracts org slug from request path, looks up cell assignment in Topology Service.

The routing rules JSON and cell registry (cell name → internal K8s service URL) are stored in the `cell-router-rules` ConfigMap and mounted into the router pod at `/etc/cell-router/`.

### Adding a cell

1. Add entry to `cells[]` in `src/config.ts` with a new `cellId`.
2. `npm run build` — rebuilds all 4 lexicons.
3. The routing-rules ConfigMap automatically gains the new cell's session prefix and token pattern. The cell registry gains the new cell's service URL.
4. `kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system` — reapplies the router ConfigMap.
5. `kubectl -n system rollout restart deploy/cell-router` — router picks up updated rules.
6. Verify: `kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.cell-registry\.json}' | jq .`

### Testing routing decisions

```bash
# Check router is ready
kubectl -n system rollout status deploy/cell-router

# From inside the cluster, test session-token routing
kubectl -n system exec deploy/cell-router -- \
  curl -s -H "Cookie: _gitlab_session=cell1_abc123" http://localhost:8080/healthz

# Inspect the routing ConfigMap
kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.routing-rules\.json}' | jq .
```

### Troubleshooting

**Router can't reach topology service:**
```bash
kubectl -n system logs deploy/cell-router | grep -i topology
kubectl -n system get networkpolicy cell-router-allow-egress -o yaml
kubectl -n system exec deploy/cell-router -- wget -qO- http://topology-service:8080/healthz
```

**Wrong cell routing:**
```bash
# Verify cell registry has the correct cell URLs
kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.cell-registry\.json}' | jq .
# Verify routing rules have correct cellId → cellName mappings
kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.routing-rules\.json}' | jq '.[0].cellPrefixMap'
```

---

## Per-Cell Runners

### How routable token format works

Each cell runner is registered with a token carrying the `glrt-cell_${cellId}_` prefix. The cell router's `RoutableTokenRule` matches this prefix against `^glrt-cell_(\d+)_` and routes CI API calls directly to the correct cell without a Topology Service lookup.

Token registration creates the prefix via `token_prefix: "glrt-cell_${CELL_ID}_"` in the `register-runners` pipeline job. The full token is stored as a K8s secret in the cell's namespace and mounted into the runner Deployment.

### Registering a new cell's runner

```bash
CELL_NAME=gamma
CELL_ID=3

RUNNER_TOKEN=$(kubectl -n cell-$CELL_NAME exec deploy/gitlab-cell-$CELL_NAME-toolbox -- \
  gitlab-rails runner "puts Ci::Runner.create!(runner_type: :instance_type, registration_type: :authenticated_user, token_prefix: \"glrt-cell_${CELL_ID}_\").token")

kubectl -n cell-$CELL_NAME create secret generic $CELL_NAME-runner-token \
  --from-literal=token=$RUNNER_TOKEN --dry-run=client -o yaml | kubectl apply -f -

kubectl -n cell-$CELL_NAME rollout restart deploy/$CELL_NAME-runner
kubectl -n cell-$CELL_NAME rollout status deploy/$CELL_NAME-runner --timeout=120s
```

### Verifying a job runs on the correct cell

```bash
# Trigger a pipeline in a project homed to cell-alpha
# Check that the job ran on the alpha runner
kubectl -n cell-alpha logs deploy/alpha-runner | grep "Job.*succeeded"

# Confirm the runner token prefix matches the cell
kubectl -n cell-alpha get secret alpha-runner-token -o jsonpath='{.data.token}' | base64 -d | head -c 20
# Should start with: glrt-cell_1_
```

### Troubleshooting

**Runner token not routable:**
```bash
# Check token has the correct prefix
kubectl -n cell-alpha get secret alpha-runner-token -o jsonpath='{.data.token}' | base64 -d
# Should match: glrt-cell_1_<rest>
```

**Runner targeting wrong cell:**
```bash
# Inspect runner config.toml for correct URL
kubectl -n cell-alpha get configmap alpha-runner-config -o jsonpath='{.data.config\.toml}'
# url should be https://alpha.<domain>
```

---

## Cell Health Monitoring

### What metrics are recorded

Per cell (driven by `cells[]` fan-out in `src/system/monitoring.ts`):

| Metric | Description |
|---|---|
| `gitlab_cell_db_latency_seconds` | p99 DB transaction duration |
| `gitlab_cell_webservice_ready_ratio` | ready pods / desired pods for webservice |
| `gitlab_cell_runner_queue_depth` | pending CI jobs in cell namespace |
| `gitlab_cell_health_score` | composite 0–1 (webservice ratio × DB latency factor) |

### Reading health scores in Grafana

```bash
# Port-forward Grafana
kubectl -n system port-forward svc/grafana 3000:3000

# Query health scores directly via Prometheus
kubectl -n system exec deploy/prometheus -- \
  wget -qO- 'http://localhost:9090/api/v1/query?query=gitlab_cell_health_score' | jq .
```

### Alerts and responses

| Alert | Threshold | Action |
|---|---|---|
| `CellUnhealthy` | health_score < 0.5 for 2m | Cell router fails over; investigate DB and webservice |
| `CellDegraded` | health_score < 0.8 for 5m | Monitor closely; check webservice pod count and DB latency |
| `CellRunnerQueueBacklog` | queue_depth > 100 for 5m | Scale runner replicas or add runner capacity |

### How health signals flow to routing

The Topology Service ConfigMap includes `prometheus.address` pointing to the in-cluster Prometheus. When the cell router queries the Topology Service for path-based routing decisions, the service can include `health_score` in its response (GetCellStatus, on GitLab roadmap). The router falls back to the next available cell if `health_score < shared.routerHealthThreshold` (default 0.5, configurable via `ROUTER_HEALTH_THRESHOLD` env var).

---

## Adding a New Cell (End-to-End)

1. Add entry to `cells[]` in `src/config.ts`:
   - Assign a unique `cellId` (increment from last)
   - Set `runnerConcurrency` and `runnerReplicas`
   - Set `canary: false` (or `true` to make it the new canary)

2. `npm run build && npm run lint` — verify clean build.

3. `kubectl apply -f config.yaml` — provisions GCP infra (Cloud SQL, Redis, GCS).
   Wait: `kubectl wait --for=condition=Ready sqlinstances --all --timeout=600s`

4. `kubectl apply -f k8s.yaml` — applies cell namespace, NetworkPolicies, ExternalSecrets, runner Deployment, and updated system resources (cell router ConfigMap, PrometheusRule).

5. `kubectl -n system rollout restart deploy/cell-router` — router picks up new cell in registry and routing rules.

6. Run the `register-runners` pipeline job for the new cell (or use the manual steps in DEPLOY.md).

7. Verify health metrics appear:
   ```bash
   kubectl -n system get prometheusrule cell-<name>-health
   kubectl -n system exec deploy/prometheus -- \
     wget -qO- 'http://localhost:9090/api/v1/query?query=gitlab_cell_health_score{cell="<name>"}' | jq .
   ```

---

## OrgMover

Org migration reassigns an organization from one cell to another. After migration:

1. Topology Service updates its org→cell mapping in Cloud SQL.
2. Path-based routing immediately resolves org requests to the new cell.
3. Session tokens are invalidated (users re-authenticate; new session token carries new cell prefix).
4. Routable tokens issued before migration continue to route to old cell until expiry.

Manual migration:
```bash
kubectl -n system exec deploy/topology-service -- \
  topology-cli migrate-org --org $ORG_ID --target-cell $TARGET_CELL
```

Or trigger the `migrate-org` pipeline job (manual stage) with `ORG_ID` and `TARGET_CELL` variables.

---

## Common Operations

| Operation | Command |
|---|---|
| Check all cell health scores | `kubectl -n system exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/query?query=gitlab_cell_health_score' \| jq .` |
| Migrate org to cell | `kubectl -n system exec deploy/topology-service -- topology-cli migrate-org --org $ORG_ID --target-cell $TARGET_CELL` |
| Add cell | Edit `cells[]` in `config.ts`, `npm run build`, `kubectl apply`, restart cell-router |
| Remove cell | Remove entry from `cells[]`, drain org traffic (migrate all orgs first), `kubectl apply`, `kubectl delete ns cell-<name>` |
| Inspect routing decision | `kubectl -n system get configmap cell-router-rules -o jsonpath='{.data.routing-rules\.json}' \| jq .` |
| Check router HPA | `kubectl -n system get hpa cell-router` |
| Re-register runner for a cell | See **Per-Cell Runners → Registering a new cell's runner** above |
| Check active alerts | `kubectl -n system exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/alerts' \| jq .` |
