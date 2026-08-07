#!/usr/bin/env bash
set -euo pipefail

# Azure property-level drift acceptance (#1213, epic #1200).
#
# The D·azure slot: prove `chant lifecycle diff <env> --live` reads an Azure
# estate deeply over ARM and reports exactly the drift that is there — against
# floci-az, for $0. The estate is the canonical example's networking (a
# VnetDefault: VNet + subnets + NSG + route table — the same composite
# k8s-aks-microservice deploys), applied per-resource by `azApply` (floci-az
# has no deployments provider), observed per-resource over the same ARM
# transport. No storage account: floci-az's modeled storage provider does not
# persist what was PUT (see test/floci-gaps.md), which would test the emulator
# rather than the drift path.
#
# Four claims, in order:
#
#   1. A clean apply is QUIET. No property drift from ARM's own echo — nested
#      self-ids, per-rule provisioningState, defaultSecurityRules, chant's own
#      ownership tags, and declared `[resourceId(...)]` expressions (which the
#      applier evaluates, so declared-vs-live is formula-vs-result) all
#      normalize away.
#   2. A HAND-EDITED NSG RULE surfaces as drift, named: somebody opening SSH to
#      the world out of band is reported path-by-path.
#   3. RG-DELETE-DOES-NOT-CASCADE (floci-az): deleting the resource group out
#      of band leaves the child resources listable. Azure observes
#      per-resource, so the estate keeps reporting — the same drift as before,
#      not a false "everything vanished".
#   4. IN-MEMORY STATE (floci-az): restarting the emulator wipes the estate.
#      Every top-level resource reports MISSING at the entity level, and the
#      property axis stays silent — an absent resource has no property drift.
#
# On-demand only — NOT part of gating CI. Needs Docker. Run it yourself:
#
#   just azure-drift-e2e     (or)   bash test/azure-drift-e2e.sh
#
# Override the emulator port with FLOCI_AZ_PORT (default 4589, chosen not to
# clash with a dev floci-az on 4577).
#
# Exit codes: 0 pass or cleanly skipped (no Docker); non-zero on a real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AZ_PORT="${FLOCI_AZ_PORT:-4589}"
AZ_NAME="chant-floci-az-drift-$$"
# Pin must match FLOCI_AZ_SPEC (lexicons/azure/src/op/activities/floci-az.ts).
AZ_IMAGE="floci/floci-az:0.10.0"
ENDPOINT="http://localhost:${AZ_PORT}"
SUB="00000000-0000-0000-0000-000000000001"
ENV_NAME="local"   # the environment IS the resource group on the azure path
ARM="${ENDPOINT}/subscriptions/${SUB}/resourceGroups/${ENV_NAME}"
WORK="$(mktemp -d)"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }
arm_status() { curl -s -o /dev/null -w "%{http_code}" "$1?api-version=2021-04-01"; }

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

export AZURE_ENDPOINT_URL="$ENDPOINT"
export PATH="$ROOT/node_modules/.bin:$PATH"

cleanup() {
  docker rm -f "$AZ_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

boot() {
  docker run -d --rm -p "${AZ_PORT}:4577" --name "$AZ_NAME" "$AZ_IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    curl -fs "${ENDPOINT}/_floci/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "boot" "floci-az did not come up on :${AZ_PORT}"
}

# ── 0. Boot floci-az ─────────────────────────────────────────────────────────
echo "=== 0. floci-az on :${AZ_PORT} ==="
boot

# ── 1. The project under test ────────────────────────────────────────────────
echo "=== 1. Scratch project at $WORK/project ==="
PROJECT="$WORK/project"
mkdir -p "$PROJECT/src" "$PROJECT/ops" "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/azure" "$PROJECT/node_modules/@intentius/chant-lexicon-azure"
ln -sfn "$ROOT/lexicons/temporal" "$PROJECT/node_modules/@intentius/chant-lexicon-temporal"

cat >"$PROJECT/package.json" <<'EOF'
{ "name": "azure-drift-e2e", "private": true, "type": "module" }
EOF

cat >"$PROJECT/chant.config.ts" <<EOF
import type { ChantConfig } from "@intentius/chant";

// The environment declares the emulator endpoint, so --live reads reach
// floci-az with no ambient export; ownership is what the serializer stamps as
// chant-* tags — the estate must not read chant's own signature back as drift.
export default {
  lexicons: ["azure", "temporal"],
  sourceDir: "src",
  environments: [{ name: "${ENV_NAME}", endpoint: "${ENDPOINT}" }],
  ownership: { stack: "azure-drift-e2e", env: "${ENV_NAME}" },
} satisfies ChantConfig;
EOF

cat >"$PROJECT/src/infra.ts" <<'EOF'
// The canonical example's networking (VnetDefault, as k8s-aks-microservice
// uses). The NSG declares one rule so the clean apply proves ARM's echo of a
// DECLARED rule normalizes away (self-id, nested provisioningState), and the
// declared cross-references are real [resourceId(...)] expressions — the
// applier evaluates them, the diff must not compare the formula to its result.
import { VnetDefault } from "@intentius/chant-lexicon-azure";

export const { virtualNetwork, subnet1, subnet2, nsg, routeTable } = VnetDefault({
  name: "drift-vnet",
  location: "eastus",
  tags: { environment: "drift-e2e" },
  defaults: {
    nsg: {
      securityRules: [
        {
          name: "allow-https",
          properties: {
            priority: 100,
            direction: "Inbound",
            access: "Allow",
            protocol: "Tcp",
            sourcePortRange: "*",
            destinationPortRange: "443",
            sourceAddressPrefix: "*",
            destinationAddressPrefix: "*",
          },
        },
      ],
    },
  },
});
EOF

cat >"$PROJECT/ops/deploy.op.ts" <<EOF
import { Op, phase, azApply } from "@intentius/chant-lexicon-temporal";

// Apply only — the harness owns the emulator lifecycle, because restarting it
// mid-run IS one of the drift conditions under test.
export default Op({
  name: "deploy",
  overview: "azure drift acceptance: direct ARM apply to floci-az",
  taskQueue: "azure-drift-e2e",
  phases: [
    phase("Apply", [
      azApply("dist/azure.json", {
        resourceGroup: "${ENV_NAME}",
        location: "eastus",
        endpoint: "${ENDPOINT}",
      }),
    ]),
  ],
});
EOF

# Out-of-band mutation: GET the NSG, add an allow-ssh-from-anywhere rule, PUT
# it back — exactly what a portal edit does, on ARM's own surface.
cat >"$WORK/mutate-nsg.mjs" <<EOF
const url = "${ARM}/providers/Microsoft.Network/networkSecurityGroups/drift-vnet-nsg?api-version=2023-05-01";
const nsg = await (await fetch(url)).json();
nsg.properties.securityRules.push({
  name: "allow-ssh",
  properties: {
    priority: 150,
    direction: "Inbound",
    access: "Allow",
    protocol: "Tcp",
    sourcePortRange: "*",
    destinationPortRange: "22",
    sourceAddressPrefix: "0.0.0.0/0",
    destinationAddressPrefix: "*",
  },
});
const res = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(nsg) });
if (res.status >= 300) { console.error("mutation PUT failed: " + res.status); process.exit(1); }
EOF

cd "$PROJECT"
# `chant run` records build provenance from the repo, so the scratch project is
# one — its own, never this checkout's.
git init -q
git config user.email drift-e2e@example.com
git config user.name "azure drift e2e"
git add -A
git commit -qm "declared estate"

# ── 2. Synthesize + apply ────────────────────────────────────────────────────
echo "=== 2. Build + apply (azApply → floci-az) ==="
chant build src --lexicon azure -o dist/azure.json >/dev/null
for kind in "Microsoft.Network/virtualNetworks" "Microsoft.Network/networkSecurityGroups" "Microsoft.Network/routeTables"; do
  grep -q "$kind" dist/azure.json || fail "build" "template is missing $kind"
done
grep -q "chant-managed-by" dist/azure.json || fail "build" "ownership marker not stamped into the template"

chant run deploy >"$WORK/apply.txt" 2>&1 || { cat "$WORK/apply.txt"; fail "apply" "chant run deploy failed"; }
[ "$(arm_status "$ARM/providers/Microsoft.Network/networkSecurityGroups/drift-vnet-nsg")" = "200" ] \
  || fail "apply" "the NSG is not on the emulator"
echo "  estate applied: vnet + subnets + nsg + route table"

# ── 3. Clean apply is quiet ──────────────────────────────────────────────────
echo "=== 3. Observe — a clean apply reports no property drift ==="
chant lifecycle diff "$ENV_NAME" --live >"$WORK/clean.txt" 2>&1 || true
grep -q "environment: ${ENV_NAME}" "$WORK/clean.txt" \
  || { cat "$WORK/clean.txt"; fail "clean" "no azure section in the live diff"; }
grep -q "5 newly observed" "$WORK/clean.txt" \
  || { cat "$WORK/clean.txt"; fail "clean" "not every declared resource was observed"; }
grep -q "MISSING" "$WORK/clean.txt" && fail "clean" "a clean apply reported resources missing"
# The property section is silent when there is nothing to say — which is the
# claim: no false drift from ARM's echo, chant's own ownership tags, or
# declared [resourceId(...)] references diffed against their evaluated values.
grep -q "PROPERTY DRIFT" "$WORK/clean.txt" && fail "clean" "a clean apply reported property drift"
if grep -q "property drift" "$WORK/clean.txt" && ! grep -q "0 property drift" "$WORK/clean.txt"; then
  cat "$WORK/clean.txt"; fail "clean" "a clean apply reported property drift"
fi
echo "  quiet: no false drift from echo, ownership tags, or [resourceId(...)] references"

# ── 4. Hand-edited NSG rule surfaces as drift ────────────────────────────────
echo "=== 4. Mutate out of band, then detect it ==="
node "$WORK/mutate-nsg.mjs" || fail "mutate" "could not PUT the out-of-band rule"
chant lifecycle diff "$ENV_NAME" --live >"$WORK/drift.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/drift.txt" || { cat "$WORK/drift.txt"; fail "drift" "the out-of-band rule was not reported as drift"; }
grep -q "nsg (Microsoft.Network/networkSecurityGroups)" "$WORK/drift.txt" \
  || fail "drift" "drift was reported but not attributed to the nsg"
grep -q "allow-ssh" "$WORK/drift.txt" || fail "drift" "the added rule is not addressed by its own name"
grep -q "0.0.0.0/0" "$WORK/drift.txt" || fail "drift" "the added rule's source CIDR is not named in the report"
echo "  somebody opening SSH to the world surfaced, named rule by rule:"
sed -n '/PROPERTY DRIFT/,$p' "$WORK/drift.txt" | sed 's/^/    /'

# ── 5. RG-orphan: delete the group, the estate keeps reporting ───────────────
echo "=== 5. RG delete does not cascade (floci-az) — orphans stay observed ==="
curl -fs -X DELETE "$ARM?api-version=2021-04-01" >/dev/null || fail "rg-orphan" "could not delete the resource group"
[ "$(arm_status "$ARM")" = "404" ] || fail "rg-orphan" "the resource group still answers after DELETE"
[ "$(arm_status "$ARM/providers/Microsoft.Network/networkSecurityGroups/drift-vnet-nsg")" = "200" ] \
  || fail "rg-orphan" "floci-az cascaded the RG delete — the orphan condition this test rides is gone"
chant lifecycle diff "$ENV_NAME" --live >"$WORK/orphan.txt" 2>&1 || true
grep -q "MISSING" "$WORK/orphan.txt" && fail "rg-orphan" "per-resource observation reported the orphaned estate missing"
grep -q "allow-ssh" "$WORK/orphan.txt" || fail "rg-orphan" "the property drift vanished with the group record"
echo "  group record gone, estate still observed per-resource, drift unchanged"

# ── 6. In-memory state: restart wipes the estate ─────────────────────────────
echo "=== 6. Emulator restart (in-memory state) — the estate reads MISSING ==="
docker rm -f "$AZ_NAME" >/dev/null
boot
chant lifecycle diff "$ENV_NAME" --live >"$WORK/wiped.txt" 2>&1 || true
grep -q "MISSING" "$WORK/wiped.txt" || { cat "$WORK/wiped.txt"; fail "wiped" "a wiped estate did not report MISSING"; }
for name in nsg virtualNetwork routeTable subnet1 subnet2; do
  grep -q "$name" "$WORK/wiped.txt" || fail "wiped" "$name is not reported after the wipe"
done
grep -q "PROPERTY DRIFT" "$WORK/wiped.txt" && fail "wiped" "an absent estate reported property drift"
echo "  absence is entity-level MISSING, not property noise"

echo
echo "PASS: clean apply quiet; hand-edited NSG rule surfaces; RG-orphan estate stays observed; wiped estate reads MISSING."
