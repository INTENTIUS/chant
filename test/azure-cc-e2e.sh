#!/usr/bin/env bash
set -euo pipefail

# Azure config-controller round-trip E2E (#1214, epic #1200).
#
# The azure lane's acceptance run: apply -> observe -> mutate-and-detect-drift ->
# reconcile -> rollback, on the canonical mixed-substrate example, against
# floci-az, for $0.
#
# Where the drift acceptance (`azure-drift-e2e.sh`, #1213) stops, this one
# starts. That run proves the observation half on a networking estate; this
# proves the whole CONTROLLER loop on the full canonical estate — RG + VNet +
# subnets + NSG + an AKS managedCluster, applied per-resource by `azApply`
# (floci-az has no deployments provider), plus a k8s Service on that cluster.
# floci-az backs the cluster with a REAL k3s container, reached through the
# cluster's own admin kubeconfig — see step 3b for what 0.10.0's
# listClusterAdminCredential does and does not give (floci-gaps entry 8).
#
# The round-trip runs in a throwaway git repo (a copy of the example), not in
# this checkout. Reconcile REWRITES source and rollback resolves `sourceDir`
# against the repo root, so running it here would both dirty the tree and
# resolve `src` to chant's own. The copy makes the rollback step meaningful:
# there is a real prior commit to roll back to.
#
# On-demand only — NOT part of gating CI. Needs Docker and kubectl. Run it:
#
#   just azure-cc-e2e     (or)   bash test/azure-cc-e2e.sh
#
# Override the emulator port with FLOCI_AZ_PORT (default 4591, chosen to clash
# with neither a dev floci-az on 4577 nor the drift acceptance's 4589).
#
# Exit codes: 0 pass or cleanly skipped (no Docker / kubectl); non-zero on a
# real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/cc-azure-canonical"
CLUSTER="cc-aks"
AZ_PORT="${FLOCI_AZ_PORT:-4591}"
AZ_NAME="chant-floci-az-cc-$$"
# Pin must match FLOCI_AZ_SPEC (lexicons/azure/src/op/activities/floci-az.ts).
AZ_IMAGE="floci/floci-az:0.10.0"
ENDPOINT="http://localhost:${AZ_PORT}"
SUB="00000000-0000-0000-0000-000000000001"
ENV_NAME="local"   # the environment IS the resource group on the azure path
ARM="${ENDPOINT}/subscriptions/${SUB}/resourceGroups/${ENV_NAME}"
AKS_URL="$ARM/providers/Microsoft.ContainerService/managedClusters/$CLUSTER"
WORK="$(mktemp -d)"
KUBECONFIG_FILE="$WORK/kubeconfig"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }
arm_status() { curl -s -o /dev/null -w "%{http_code}" "$1?api-version=2021-04-01"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v kubectl >/dev/null 2>&1 || skip "kubectl not installed"
[ -S /var/run/docker.sock ] || skip "no docker socket at /var/run/docker.sock (floci-az starts the AKS k3s container through it)"

export AZURE_ENDPOINT_URL="$ENDPOINT"
export KUBECONFIG="$KUBECONFIG_FILE"
# The project under test lives outside this checkout (see the header), so `npx`
# cannot walk up to the repo's node_modules for the `tsx` the chant bin needs.
export PATH="$ROOT/node_modules/.bin:$PATH"

# The k3s container floci-az starts for the cluster — resolved in step 3 from
# the cluster's own fqdn, used by cleanup.
K3S_CONTAINER=""

cleanup() {
  # ARM DELETE first, so floci-az stops its own k3s child; then belt-and-braces
  # for the container and its named volume, which outlive an emulator that is
  # rm -f'd rather than shut down.
  curl -fs -X DELETE "$AKS_URL?api-version=2021-04-01" >/dev/null 2>&1 || true
  docker rm -f "$AZ_NAME" >/dev/null 2>&1 || true
  if [ -n "$K3S_CONTAINER" ]; then
    docker rm -f "$K3S_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$K3S_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 0. Boot floci-az ─────────────────────────────────────────────────────────
# The docker socket is mounted because floci-az starts a k3s container to back
# the AKS cluster. Without it the cluster reports provisioningState Failed,
# which reads like an AKS gap and is not one.
echo "=== 0. floci-az on :${AZ_PORT} ==="
docker run -d --rm -p "${AZ_PORT}:4577" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name "$AZ_NAME" "$AZ_IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fs "${ENDPOINT}/_floci/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "${ENDPOINT}/_floci/health" >/dev/null 2>&1 \
  || fail "boot" "floci-az did not come up on :${AZ_PORT}"

# The lexicon registries the run needs: the azure and k8s generated barrels
# (absent from a fresh checkout — `just test`'s _ensure-gen builds them for the
# suite, this run may be standalone) and the azure bundle (dist/meta.json, what
# the live-import generator reads — without it the reconcile step dies on a
# module-not-found that says nothing about reconcile).
echo "=== 0b. Lexicon artifacts (generated barrels + azure bundle) ==="
[ -f "$ROOT/lexicons/azure/src/generated/index.ts" ] \
  || npm --prefix "$ROOT/lexicons/azure" run generate >/dev/null 2>&1 \
  || fail "bundle" "could not generate the azure lexicon barrel"
[ -f "$ROOT/lexicons/k8s/src/generated/index.ts" ] \
  || npm --prefix "$ROOT/lexicons/k8s" run generate >/dev/null 2>&1 \
  || fail "bundle" "could not generate the k8s lexicon barrel"
npm --prefix "$ROOT/lexicons/azure" run bundle >/dev/null 2>&1 \
  || fail "bundle" "could not build the azure lexicon bundle"

# ── 1. The project under test: a throwaway git repo ──────────────────────────
echo "=== 1. Canonical example -> throwaway repo at $WORK/project ==="
mkdir -p "$WORK/project"
cp -R "$EXAMPLE/." "$WORK/project/"
rm -rf "$WORK/project/node_modules" "$WORK/project/template.json" "$WORK/project/k8s.yaml"
PROJECT="$WORK/project"
mkdir -p "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/azure" "$PROJECT/node_modules/@intentius/chant-lexicon-azure"
ln -sfn "$ROOT/lexicons/k8s" "$PROJECT/node_modules/@intentius/chant-lexicon-k8s"
ln -sfn "$ROOT/lexicons/temporal" "$PROJECT/node_modules/@intentius/chant-lexicon-temporal"
cd "$PROJECT"
git init -q
git config user.email cc-e2e@example.com
git config user.name "cc e2e"
git add -A
git commit -qm "declared source, before the round-trip"
BASE_REF="$(git rev-parse --short HEAD)"
echo "  base revision $BASE_REF"

# ── 2. Synthesize both substrates ────────────────────────────────────────────
echo "=== 2. Synthesize ==="
chant build src --lexicon azure -o template.json >/dev/null
chant build src --lexicon k8s -o k8s.yaml >/dev/null
for kind in "Microsoft.Network/virtualNetworks" "Microsoft.Network/networkSecurityGroups" \
            "Microsoft.Network/routeTables" "Microsoft.ContainerService/managedClusters"; do
  grep -q "$kind" template.json || fail "synthesize" "template is missing $kind"
done
grep -q "chant-managed-by" template.json || fail "synthesize" "ownership marker not stamped into the template"
grep -q "kind: Service" k8s.yaml || fail "synthesize" "k8s output is missing the Service"
echo "  cloud half + k8s half synthesized"

# ── 3. APPLY (code -> cloud) ─────────────────────────────────────────────────
echo "=== 3. Apply — azApply PUTs the estate per-resource ==="
chant run cc-azure-deploy >"$WORK/apply.txt" 2>&1 || { cat "$WORK/apply.txt"; fail "apply" "chant run cc-azure-deploy failed"; }
[ "$(arm_status "$ARM/providers/Microsoft.Network/networkSecurityGroups/cc-vnet-nsg")" = "200" ] \
  || fail "apply" "the NSG is not on the emulator"

# The AKS cluster is applied by the same template and floci-az starts a real
# k3s container behind it. 0.10.0's own readiness poller never confirms it
# (floci-gaps entry 8: provisioningState stays Creating, silently, while the
# apiserver behind it is genuinely up), so the gate below is the cluster's own
# /readyz through the extracted kubeconfig — the substrate's truth, not the
# emulator's state string. Failed is still a hard stop: that is the docker
# socket missing, or a stale floci-az-aks-* container holding the apiserver
# port range (check docker ps).
CS="$(curl -s "$AKS_URL?api-version=2021-04-01" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => console.log(JSON.parse(d).properties?.provisioningState ?? "ABSENT"));
')"
[ "$CS" = "Failed" ] && fail "apply" "AKS cluster reported Failed (is the docker socket mounted? a stale floci-az-aks-* container from an earlier run may also be holding the apiserver port range — check docker ps)"
[ "$CS" = "ABSENT" ] && fail "apply" "the AKS cluster is not on the emulator"
FQDN="$(curl -s "$AKS_URL?api-version=2021-04-01" | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => console.log(JSON.parse(d).properties?.fqdn ?? ""));
')"
K3S_CONTAINER="${FQDN%%:*}"
[ -n "$K3S_CONTAINER" ] || fail "apply" "the cluster carries no fqdn to find its k3s container by"
echo "  estate applied; AKS $CS, k3s container $K3S_CONTAINER"

# ── 3b. The cluster's own kubeconfig ─────────────────────────────────────────
# listClusterAdminCredential answers and names the cluster's endpoint — that
# much is asserted. What 0.10.0 puts in it is a mock token the real k3s
# apiserver rejects, with the docker-network container name as the server
# (floci-gaps entry 8; the emulator's own finalizeCluster — extract k3s.yaml,
# rewrite the server — is not in the 0.10.0 image). So the harness performs the
# same finalize itself: read /etc/rancher/k3s/k3s.yaml out of the cluster's
# container and point it at the host-published apiserver port.
echo "=== 3b. Kubeconfig — listClusterAdminCredential, then the 0.10.0 finalize gap ==="
curl -fs -X POST "$AKS_URL/listClusterAdminCredential?api-version=2021-04-01" >"$WORK/cred.json" \
  || fail "kubeconfig" "listClusterAdminCredential did not answer"
node -e '
  const fs = require("fs");
  const cred = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const kc = Buffer.from(cred.kubeconfigs[0].value, "base64").toString();
  if (!kc.includes(process.argv[2])) { console.error("credential does not name the cluster endpoint"); process.exit(1); }
' "$WORK/cred.json" "$FQDN" || fail "kubeconfig" "the admin credential does not carry the cluster endpoint"
HOST_PORT="$(docker port "$K3S_CONTAINER" 6443/tcp | head -1 | sed 's/.*://')"
[ -n "$HOST_PORT" ] || fail "kubeconfig" "the k3s container publishes no host port for 6443"
# k3s writes its admin kubeconfig during bootstrap — retry until it is there.
for _ in $(seq 1 30); do
  docker exec "$K3S_CONTAINER" cat /etc/rancher/k3s/k3s.yaml >"$WORK/k3s.yaml" 2>/dev/null && break
  sleep 2
done
[ -s "$WORK/k3s.yaml" ] || fail "kubeconfig" "could not extract the k3s admin kubeconfig"
sed "s#server: https://[^\\n]*#server: https://127.0.0.1:${HOST_PORT}#" "$WORK/k3s.yaml" >"$KUBECONFIG_FILE"
for _ in $(seq 1 60); do
  kubectl get --raw /readyz >/dev/null 2>&1 && break
  sleep 2
done
kubectl get --raw /readyz >/dev/null 2>&1 || fail "kubeconfig" "the apiserver never became ready through the extracted kubeconfig"
echo "  credential surface asserted; working admin kubeconfig extracted (:${HOST_PORT})"

# ── 3c. The k8s half, released by its component (#1495) ──────────────────────
# cc-workload's kubectl-apply step stamps the field manager
# `chant:cc-azure-canonical` and prunes only within that marker — the release
# path and the ownership model are the same mechanism.
echo "=== 3c. Apply — the cc-workload component kubectl-applies the k8s half ==="
chant run --components cc-workload --env local --no-release-record >"$WORK/workload.txt" 2>&1 \
  || { cat "$WORK/workload.txt"; fail "apply" "the cc-workload component could not kubectl-apply the k8s half"; }
kubectl get service cc-api -n default >/dev/null 2>&1 || fail "apply" "the Service is not on the cluster"
echo "  k8s half applied through the cluster's own kubeconfig"

# ── 4. OBSERVE (both substrates, one read) ───────────────────────────────────
echo "=== 4. Observe — one --live read covering both substrates ==="
chant lifecycle diff "$ENV_NAME" --live >"$WORK/observe.txt" 2>&1 || true
grep -q "environment: ${ENV_NAME}" "$WORK/observe.txt" \
  || { cat "$WORK/observe.txt"; fail "observe" "no azure section in the live diff"; }
grep -q "apiService" "$WORK/observe.txt" \
  || { cat "$WORK/observe.txt"; fail "observe" "the k8s Service was not observed — the cluster half is missing from the read"; }
grep -q "MISSING" "$WORK/observe.txt" && { cat "$WORK/observe.txt"; fail "observe" "a clean apply reported resources missing"; }
# The property axis is silent on a clean apply: ARM's echo, chant's own
# ownership tags, evaluated [resourceId(...)] references and the AKS
# server-computed surface (fqdn / currentKubernetesVersion / nodeResourceGroup)
# all normalize away.
grep -q "PROPERTY DRIFT" "$WORK/observe.txt" && { cat "$WORK/observe.txt"; fail "observe" "a clean apply reported property drift"; }
echo "  both substrates observed; clean apply is quiet"

# The k8s deploy unit observed by its own lexicon (#1495): cc-workload's
# kubectl-apply unit through k8s's describeStackStatus, which selects on the
# ownership labels the build stamped — so this also proves the stamp survived
# the round trip. (The azure half is Op-applied — floci-az has no deployments
# provider — so there is no azure component row to assert.)
chant components status "$ENV_NAME" --live --json --no-release-record >"$WORK/components.json" 2>/dev/null \
  || fail "observe" "components status --live failed"
node -e '
  const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows;
  const row = rows.find((r) => r.component === "cc-workload");
  if (!row) { console.error("no status row for cc-workload"); process.exit(1); }
  if (!row.live) { console.error("cc-workload is not live: " + JSON.stringify(row)); process.exit(1); }
  if (row.stack?.name !== "cc-azure-canonical") { console.error("cc-workload observed stack " + JSON.stringify(row.stack)); process.exit(1); }
' "$WORK/components.json" || fail "observe" "components status --live did not report the kubectl-apply unit (see $WORK/components.json)"
echo "  components status --live reports the kubectl-apply unit"

# ── 5. MUTATE + DETECT DRIFT ─────────────────────────────────────────────────
# Out of band, exactly as a portal edit would be: GET the NSG, push an
# allow-ssh-from-anywhere rule, PUT it back, on ARM's own surface.
echo "=== 5. Mutate out of band, then detect it ==="
node -e '
  const url = process.argv[1];
  (async () => {
    const nsg = await (await fetch(url)).json();
    nsg.properties.securityRules.push({
      name: "allow-ssh",
      properties: {
        priority: 150, direction: "Inbound", access: "Allow", protocol: "Tcp",
        sourcePortRange: "*", destinationPortRange: "22",
        sourceAddressPrefix: "0.0.0.0/0", destinationAddressPrefix: "*",
      },
    });
    const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(nsg) });
    if (res.status >= 300) { console.error("mutation PUT failed: " + res.status); process.exit(1); }
  })();
' "$ARM/providers/Microsoft.Network/networkSecurityGroups/cc-vnet-nsg?api-version=2023-05-01" \
  || fail "mutate" "could not PUT the out-of-band rule"
chant lifecycle diff "$ENV_NAME" --live >"$WORK/drift.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/drift.txt" || { cat "$WORK/drift.txt"; fail "drift" "the out-of-band rule was not reported as drift"; }
grep -q "nsg (Microsoft.Network/networkSecurityGroups)" "$WORK/drift.txt" \
  || fail "drift" "drift was reported but not attributed to the nsg"
grep -q "allow-ssh" "$WORK/drift.txt" || fail "drift" "the added rule is not addressed by its own name"
grep -q "0.0.0.0/0" "$WORK/drift.txt" || fail "drift" "the added rule's source CIDR is not named in the report"
echo "  somebody opening SSH to the world surfaced, named"

# ── 6. RECONCILE (cloud -> code) ─────────────────────────────────────────────
# Live import over the applier's own ARM transport (#1214): list the group,
# read each resource whole, regenerate TypeScript. The AKS cluster is absent
# from floci-az's resource list (floci-gaps entry 10), so the networking
# estate is what the export can carry — the authored cluster source stays.
echo "=== 6. Reconcile — regenerate source from live ==="
# `--output src`: with no `stacks` entry (the azure path's env-is-RG
# convention) live import would default to ./infra/; the round-trip's claim is
# that live reality lands back in the project's own source tree.
chant import --from "$ENV_NAME" --output src --force >"$WORK/reconcile.txt" 2>&1 \
  || { cat "$WORK/reconcile.txt"; fail "reconcile" "live import failed"; }
[ -n "$(git status --porcelain -- src)" ] \
  || fail "reconcile" "import changed nothing — the drifted rule did not reach source"
grep -rq "0.0.0.0/0" src/ || fail "reconcile" "regenerated source does not carry the out-of-band rule"
for name in cc-vnet cc-vnet-nsg cc-vnet-rt subnet-1 subnet-2; do
  grep -rq "$name" src/ || fail "reconcile" "regenerated source lost $name"
done
grep -rq "cc-aks" src/ || fail "reconcile" "the authored cluster source did not survive the import"
echo "  live reality is back in TypeScript, drift included"

# ── 7. ROLLBACK (git-source) ─────────────────────────────────────────────────
# The delta that would undo the reconcile. `--dry-run` because a rollback PR
# needs a GitHub remote and `gh`, and this run has neither by design.
echo "=== 7. Rollback — the delta back to the declared source ==="
git add -A
git commit -qm "reconciled from live (includes the out-of-band rule)"
chant lifecycle rollback "$ENV_NAME" --to "$BASE_REF" --dry-run >"$WORK/rollback.diff" 2>"$WORK/rollback.err" \
  || { cat "$WORK/rollback.err"; fail "rollback" "rollback --dry-run failed"; }
[ -s "$WORK/rollback.diff" ] || fail "rollback" "rollback produced an empty delta"
grep -q "^-.*0\.0\.0\.0/0" "$WORK/rollback.diff" \
  || fail "rollback" "the rollback delta does not remove the out-of-band rule"
git rev-parse --verify "chant/rollback-${ENV_NAME}-${BASE_REF}" >/dev/null 2>&1 \
  && fail "rollback" "--dry-run left a branch behind"
echo "  delta removes the drifted rule; nothing pushed, no branch left"

echo
echo "PASS: apply -> observe -> drift -> reconcile -> rollback, both substrates, on floci-az."
echo "  cloud half : VNet/subnets/NSG/route table + AKS on $ENDPOINT"
echo "  k8s half   : Service on $CLUSTER via 127.0.0.1:${HOST_PORT}"
