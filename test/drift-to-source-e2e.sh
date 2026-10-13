#!/usr/bin/env bash
set -euo pipefail

# Drift lands on the line you wrote: the k3d demo for examples/k8s-drift-to-source.
#
# The example declares a `WebApp` composite call that sets a Deployment's
# replica count from its `replicas` argument, and a `worker` Deployment written
# directly. This script deploys both to a throwaway k3d cluster, changes a
# replica count behind chant's back with `kubectl scale`, and runs
# `chant lifecycle diff local --live`. The claim it checks:
#
#   the drifted field is reported against the composite argument that set it,
#   with the file and line that argument was written on, in the human report
#   and in --json.
#
# BREAK=1 scales the directly written `worker` Deployment instead. That field
# has no composite behind it, and the run passes only if the diff attributes it
# as direct: no composite named, `origin.kind` "direct" in --json. A demo that
# named a composite for every drifted field would fail here, so the main run's
# assertion is shown to depend on where the field was actually written.
#
# On-demand only, not part of gating CI. Needs Docker, k3d and kubectl:
#
#   just drift-to-source-e2e            (or)   bash test/drift-to-source-e2e.sh
#   BREAK=1 just drift-to-source-e2e
#
# Knobs: SMOKE_KEEP=1 leaves the cluster running. The cluster is created with
# its own kubeconfig file, so your default kube context is never touched.
#
# Every step prints one verdict line, `SMOKE op=<name> verdict=<pass|caught|fail> <detail>`.
# Exit codes: 0 pass (or caught, under BREAK=1) or cleanly skipped; 1 on a failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/k8s-drift-to-source"
CLUSTER="chant-drift-to-source"
WORK="$(mktemp -d)"
ENV_NAME="local"
export PATH="$ROOT/node_modules/.bin:$PATH"
export NO_COLOR=1

ok()       { echo "SMOKE op=$1 verdict=pass $2"; }
caught()   { echo "SMOKE op=$1 verdict=caught $2"; }
fail()     { echo "SMOKE op=$1 verdict=fail $2" >&2; exit 1; }
skip()     { echo "SKIP: $1"; exit 0; }
step()     { echo; echo "== $*"; }
evidence() { sed 's/^/      /'; }
chant()    { "$ROOT/packages/core/bin/chant" "$@"; }

command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"
command -v k3d >/dev/null 2>&1 || skip "k3d not installed"
command -v kubectl >/dev/null 2>&1 || skip "kubectl not installed"
command -v jq >/dev/null 2>&1 || skip "jq not installed"

cleanup() {
  if [ "${SMOKE_KEEP:-}" != "1" ]; then
    k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "smoke: drift lands on the line you wrote${BREAK:+ with BREAK=1}"

# ── 0. A cluster of its own ──────────────────────────────────────────────────
step "0. k3d cluster $CLUSTER"
k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER" --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --wait --timeout 180s >"$WORK/k3d.log" 2>&1 || { cat "$WORK/k3d.log"; fail cluster "k3d could not create the cluster"; }
k3d kubeconfig get "$CLUSTER" >"$WORK/kubeconfig"
export KUBECONFIG="$WORK/kubeconfig"
ok cluster "k3d cluster up, kubeconfig at its own path"

# ── 1. The example, as a project of its own ──────────────────────────────────
step "1. build the example"
PROJECT="$WORK/project"
mkdir -p "$PROJECT/node_modules/@intentius"
cp -R "$EXAMPLE/src" "$EXAMPLE/composites" "$EXAMPLE/chant.config.ts" "$EXAMPLE/package.json" "$EXAMPLE/tsconfig.json" "$PROJECT/"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/k8s" "$PROJECT/node_modules/@intentius/chant-lexicon-k8s"
cd "$PROJECT"
# `lifecycle diff` reads snapshots off this repository's chant/lifecycle
# branch, so the scratch project is a repository of its own, never this checkout.
git init -q
git config user.email drift-to-source@example.com
git config user.name "drift-to-source e2e"
git add -A
git commit -qm "declared estate"

chant build src --lexicon k8s -o k8s.yaml >"$WORK/build.txt" 2>&1 || { cat "$WORK/build.txt"; fail build "chant build failed"; }
grep -q "name: web-app" k8s.yaml || fail build "the WebApp Deployment is not in the output"
grep -q "name: worker" k8s.yaml || fail build "the worker Deployment is not in the output"
ok build "k8s.yaml holds the WebApp Deployment and Service and the worker Deployment"

# The line the replicas argument is written on, read from the source rather
# than hard-coded, so editing the example cannot leave the assertion stale.
ARG_LINE="$(grep -n "replicas: 3," src/app.ts | head -1 | cut -d: -f1)"
[ -n "$ARG_LINE" ] || fail build "src/app.ts has no 'replicas: 3,' argument"

# ── 2. Deploy ────────────────────────────────────────────────────────────────
step "2. apply with kubectl as field manager chant"
kubectl apply --server-side --field-manager=chant -f k8s.yaml >"$WORK/apply.txt" 2>&1 \
  || { cat "$WORK/apply.txt"; fail apply "kubectl apply failed"; }
kubectl get deployment web-app worker >/dev/null 2>&1 || fail apply "the Deployments are not on the cluster"
ok apply "web-app (3 replicas) and worker (2 replicas) applied"

# ── 3. A clean apply reports no property drift ───────────────────────────────
step "3. live diff right after the apply"
chant lifecycle diff "$ENV_NAME" --live >"$WORK/clean.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/clean.txt" && { cat "$WORK/clean.txt"; fail clean "a clean apply reported property drift"; }
ok clean "no property drift right after the apply"

# ── 4. Change a replica count behind chant's back ────────────────────────────
if [ "${BREAK:-}" = "1" ]; then
  TARGET="worker"; ENTITY="worker"; DECLARED=2; LIVE=4
else
  TARGET="web-app"; ENTITY="webDeployment"; DECLARED=3; LIVE=5
fi
step "4. kubectl scale deployment $TARGET --replicas=$LIVE"
kubectl scale deployment "$TARGET" --replicas="$LIVE" >/dev/null
ok scale "$TARGET scaled from $DECLARED to $LIVE outside chant"

# ── 5. The live diff names where the field was written ───────────────────────
step "5. chant lifecycle diff $ENV_NAME --live"
chant lifecycle diff "$ENV_NAME" --live >"$WORK/drift.txt" 2>&1 || true
chant lifecycle diff "$ENV_NAME" --live --json >"$WORK/drift.json" 2>"$WORK/drift-json.err" || true
sed -n '/PROPERTY DRIFT/,$p' "$WORK/drift.txt" | evidence
grep -q "spec.replicas: $DECLARED → $LIVE" "$WORK/drift.txt" \
  || { cat "$WORK/drift.txt"; fail drift "the scaled replica count was not reported as drift"; }
ROW="$(jq -c --arg e "$ENTITY" '.lexicons.k8s.reconcile[] | select(.entity == $e and .path == "spec.replicas")' "$WORK/drift.json")"
[ -n "$ROW" ] || { cat "$WORK/drift.json"; fail json "--json has no reconcile row for $ENTITY spec.replicas"; }
echo "      --json origin: $(echo "$ROW" | jq -c .origin)"

if [ "${BREAK:-}" = "1" ]; then
  # The directly written field: direct, and no composite named for it.
  [ "$(echo "$ROW" | jq -r .origin.kind)" = "direct" ] || fail direct "--json does not attribute worker spec.replicas as direct"
  grep -q "spec.replicas: $DECLARED → $LIVE \[from: authored\]" "$WORK/drift.txt" \
    || fail direct "the report does not show worker spec.replicas as authored in source"
  grep -q "worker comes from" "$WORK/drift.txt" && fail direct "the report names a composite for a field written directly"
  grep -q "worker has an unknown origin" "$WORK/drift.txt" && fail direct "the report calls a direct field unknown"
  caught direct "worker spec.replicas is attributed as direct: no composite argument named for it"
else
  EXPECT="spec.replicas on K8s::Apps::Deployment webDeployment comes from WebApp({ replicas: 3 }) at src/app.ts:$ARG_LINE"
  grep -qF "$EXPECT" "$WORK/drift.txt" || fail names-argument "the report does not say: $EXPECT"
  ok names-argument "$EXPECT"
  [ "$(echo "$ROW" | jq -r .origin.kind)" = "composite-parameter" ] || fail json "--json origin is not composite-parameter"
  [ "$(echo "$ROW" | jq -r '.origin.arguments[0].line')" = "$ARG_LINE" ] || fail json "--json argument line is not $ARG_LINE"
  [ "$(echo "$ROW" | jq -r '.origin.arguments[0].text')" = "replicas: 3" ] || fail json "--json argument text is not 'replicas: 3'"
  ok json "--json carries the origin: composite WebApp, argument 'replicas: 3' at line $ARG_LINE"
fi

echo
if [ "${BREAK:-}" = "1" ]; then
  echo "CAUGHT: a field written directly on a resource is attributed as direct, never to a composite."
else
  echo "PASS: drift on spec.replicas is reported against WebApp({ replicas: 3 }) at src/app.ts:$ARG_LINE."
fi
