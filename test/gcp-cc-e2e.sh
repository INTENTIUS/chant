#!/usr/bin/env bash
set -euo pipefail

# GCP config-controller round-trip E2E (#1211, epic #1199).
#
# The GCP lane's acceptance run: apply -> observe -> mutate-and-detect-drift ->
# remediate -> destroy, on the canonical GCP estate, against floci-gcp, for $0.
#
# GCP applies per-resource via direct REST (no CloudFormation, no cluster), so
# where the AWS run (`aws-cc-e2e.sh`) proves the loop through a deploy service,
# this proves it with chant holding every REST call itself: gcpApply writes the
# estate, the #1209/#1210 readers observe it back over the same transport, and
# a second apply is the remediation — PATCHing the drifted resource back to its
# declared state.
#
# Scope, stated plainly (epic #1199's coverage note):
#  - The estate is every kind the applier can write (gcp-apply.ts MAPPERS):
#    GCS bucket, Pub/Sub topic + subscription, Secret Manager secret, IAM
#    service account, Cloud Run service. No GKE half: the applier has no
#    ContainerCluster mapper yet, so the mixed-substrate clause of #1211 waits
#    on that, and this run says so rather than faking it.
#  - No VPC/network resources: floci-gcp emulates no networking
#    (floci-io/floci-gcp#100); the reachability demonstration stays AWS/Azure.
#  - Remediation is cloud-side (re-apply PATCHes live back to declared), not
#    source-side: `chant import --from` for GCP still rides the kubectl/Config
#    Connector transport (export-resources.ts), which floci-gcp does not have.
#  - The bucket declares no `uniformBucketLevelAccess`: floci-gcp drops
#    `iamConfiguration` on insert (test/floci-gaps.md entry 6), and declaring
#    it would put one honest `absent` drift on every clean apply.
#
# The emulator is booted through `chant emulator up --lexicon gcp` (#920), so
# the run also proves that capability end to end: the container name and port
# (chant-floci-gcp, :4588) are the capability's own, fixed by FLOCI_GCP_SPEC.
# Any floci-gcp already running under that name is recycled for a clean slate.
#
# On-demand only — NOT part of gating CI. Needs Docker. Run it yourself:
#
#   just gcp-cc-e2e     (or)   bash test/gcp-cc-e2e.sh
#
# Exit codes: 0 pass or cleanly skipped (no Docker); non-zero on real failure.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/cc-gcp-canonical"
ENDPOINT="http://localhost:4588"
PROJECT_ID="local-project"
WORK="$(mktemp -d)"

skip() { echo "SKIP: $1"; exit 0; }
fail() { echo "FAIL [$1]: $2"; exit 1; }
chant() { "$ROOT/packages/core/bin/chant" "$@"; }

# ── Preconditions ────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || skip "docker not installed"
docker info >/dev/null 2>&1 || skip "docker daemon not reachable"

# `npx` in the throwaway project cannot walk up to this repo's node_modules for
# the `tsx` the chant bin needs.
export PATH="$ROOT/node_modules/.bin:$PATH"

cleanup() {
  (cd "$PROJECT" 2>/dev/null && chant emulator down --lexicon gcp >/dev/null 2>&1) || true
  docker rm -f chant-floci-gcp >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── 1. The project under test: a throwaway copy of the example ───────────────
echo "=== 1. Canonical example -> throwaway project at $WORK/project ==="
mkdir -p "$WORK/project"
cp -R "$EXAMPLE/." "$WORK/project/"
rm -rf "$WORK/project/node_modules" "$WORK/project/dist"
PROJECT="$WORK/project"
mkdir -p "$PROJECT/node_modules/@intentius"
ln -sfn "$ROOT/packages/core" "$PROJECT/node_modules/@intentius/chant"
ln -sfn "$ROOT/lexicons/gcp" "$PROJECT/node_modules/@intentius/chant-lexicon-gcp"
ln -sfn "$ROOT/lexicons/temporal" "$PROJECT/node_modules/@intentius/chant-lexicon-temporal"
cd "$PROJECT"
# `chant run` refuses to work outside a git repository.
git init -q
git config user.email cc-e2e@example.com
git config user.name "cc e2e"
git add -A
git commit -qm "declared source"

# ── 2. Boot floci-gcp through the emulator capability (#920) ─────────────────
# Recycle any leftover container first: the estate's assertions assume an empty
# emulator, and floci-gcp keeps state for as long as the container lives.
echo "=== 2. chant emulator up --lexicon gcp ==="
chant emulator down --lexicon gcp >/dev/null 2>&1 || true
chant emulator up --lexicon gcp >"$WORK/emulator.txt" 2>&1 \
  || { cat "$WORK/emulator.txt"; fail "boot" "chant emulator up --lexicon gcp failed"; }
curl -fs "$ENDPOINT/_floci-gcp/health" >/dev/null 2>&1 \
  || fail "boot" "floci-gcp did not answer its health endpoint on :4588"

# ── 3. Synthesize ────────────────────────────────────────────────────────────
echo "=== 3. Synthesize — chant build -> dist/gcp.yaml ==="
chant build src --lexicon gcp -o dist/gcp.yaml >"$WORK/build.txt" 2>&1 \
  || { cat "$WORK/build.txt"; fail "synthesize" "chant build failed"; }
for kind in StorageBucket PubSubTopic PubSubSubscription SecretManagerSecret IAMServiceAccount RunService; do
  grep -q "kind: $kind" dist/gcp.yaml || fail "synthesize" "manifest is missing $kind"
done
grep -q "cnrm.cloud.google.com/project-id: $PROJECT_ID" dist/gcp.yaml \
  || fail "synthesize" "the project annotation did not merge into the manifest"
echo "  all six appliable kinds synthesized, project annotation merged"

# ── 4. APPLY (code -> cloud) ─────────────────────────────────────────────────
echo "=== 4. Apply — chant run cc-gcp-deploy (gcpApply, direct REST) ==="
chant run cc-gcp-deploy >"$WORK/apply.txt" 2>&1 \
  || { cat "$WORK/apply.txt"; fail "apply" "chant run deploy failed"; }
# Every kind lands as its own REST object — read each back by its resource URL.
curl -fs "$ENDPOINT/storage/v1/b/cc-gcp-assets" >/dev/null \
  || fail "apply" "the bucket is not on the emulator"
curl -fs "$ENDPOINT/v1/projects/$PROJECT_ID/topics/cc-gcp-events" >/dev/null \
  || fail "apply" "the topic is not on the emulator"
curl -fs "$ENDPOINT/v1/projects/$PROJECT_ID/subscriptions/cc-gcp-worker" >/dev/null \
  || fail "apply" "the subscription is not on the emulator"
curl -fs "$ENDPOINT/v1/projects/$PROJECT_ID/secrets/cc-gcp-api-key" >/dev/null \
  || fail "apply" "the secret is not on the emulator"
curl -fs "$ENDPOINT/v1/projects/$PROJECT_ID/serviceAccounts/cc-gcp-probe@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null \
  || fail "apply" "the service account is not on the emulator"
curl -fs "$ENDPOINT/v2/projects/$PROJECT_ID/locations/us-central1/services/cc-gcp-api" >/dev/null \
  || fail "apply" "the Cloud Run service is not on the emulator"
echo "  all six resources answer their REST resource URLs"

# ── 5. OBSERVE (clean apply is quiet) ────────────────────────────────────────
# The `local` environment's declared endpoint is what points the readers at the
# emulator (applyLiveEndpoint injects GCP_ENDPOINT_URL) — nothing is exported
# here, deliberately, so the run proves the config-file path.
echo "=== 5. Observe — chant lifecycle diff local --live ==="
chant lifecycle diff local --live >"$WORK/observe.txt" 2>&1 || true
# All six declared entities read back live, none missing on the identity axis…
grep -q "0 missing, 0 orphan, 0 disappeared, 6 newly observed" "$WORK/observe.txt" \
  || { cat "$WORK/observe.txt"; fail "observe" "the live read did not cover all six resources"; }
# …and the property axis is silent: the deep section only renders when it has
# drift, unobserved holes or undeclared entities to report.
grep -q "PROPERTY DRIFT" "$WORK/observe.txt" \
  && { cat "$WORK/observe.txt"; fail "observe" "a clean apply reported property drift"; }
grep -q "PROPERTIES UNOBSERVED" "$WORK/observe.txt" \
  && { cat "$WORK/observe.txt"; fail "observe" "the deep read left declared properties unobserved"; }
grep -q "No drift detected" "$WORK/observe.txt" \
  || { cat "$WORK/observe.txt"; fail "observe" "the diff did not come back clean"; }
echo "  all six observed; clean apply is quiet on both axes"

# ── 6. MUTATE + DETECT DRIFT ─────────────────────────────────────────────────
# Out of band, exactly as a console edit would be: the bucket's storage class
# changes (#1582's acceptance edit), and a label nobody declared appears — the
# #1191 class, a live fact with no declared counterpart.
echo "=== 6. Mutate out of band, then detect it ==="
curl -fs -X PATCH "$ENDPOINT/storage/v1/b/cc-gcp-assets" \
  -H 'content-type: application/json' \
  -d '{"storageClass":"COLDLINE","labels":{"team":"platform"}}' >/dev/null \
  || fail "drift" "could not PATCH the bucket out of band"
chant lifecycle diff local --live >"$WORK/drift.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/drift.txt" \
  || { cat "$WORK/drift.txt"; fail "drift" "the out-of-band edit was not reported as drift"; }
grep -q "assets" "$WORK/drift.txt" \
  || fail "drift" "drift was reported but not attributed to the bucket"
grep -q "COLDLINE" "$WORK/drift.txt" \
  || fail "drift" "the changed storage class is not named in the drift report"
grep -q "team" "$WORK/drift.txt" \
  || fail "drift" "the undeclared out-of-band label did not surface (#1191 class)"
echo "  storageClass STANDARD -> COLDLINE surfaced; undeclared label surfaced"

# ── 7. REMEDIATE (code -> cloud, again) ──────────────────────────────────────
# gcpApply reconciles in place: present resources are PATCHed back to their
# declared state. This is the remediation direction GCP supports today —
# source-side reconcile (`chant import --from`) still rides the Config
# Connector transport the emulator does not have (see the header).
echo "=== 7. Remediate — re-apply, drift is gone ==="
chant run cc-gcp-deploy >"$WORK/reapply.txt" 2>&1 \
  || { cat "$WORK/reapply.txt"; fail "remediate" "the remediating re-apply failed"; }
chant lifecycle diff local --live >"$WORK/after.txt" 2>&1 || true
grep -q "PROPERTY DRIFT" "$WORK/after.txt" \
  && { cat "$WORK/after.txt"; fail "remediate" "drift survived the re-apply"; }
grep -q "No drift detected" "$WORK/after.txt" \
  || { cat "$WORK/after.txt"; fail "remediate" "the post-remediation diff did not come back clean"; }
echo "  the declared state is live again"

# ── 8. DESTROY ───────────────────────────────────────────────────────────────
echo "=== 8. Destroy — chant run cc-gcp-destroy, then emulator down ==="
chant run cc-gcp-destroy >"$WORK/destroy.txt" 2>&1 \
  || { cat "$WORK/destroy.txt"; fail "destroy" "chant run destroy failed"; }
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/storage/v1/b/cc-gcp-assets")"
[ "$STATUS" = "404" ] || fail "destroy" "the bucket survived destroy (GET returned $STATUS)"
chant emulator down --lexicon gcp >/dev/null 2>&1 \
  || fail "destroy" "chant emulator down --lexicon gcp failed"

echo
echo "PASS: apply -> observe -> drift -> remediate -> destroy on floci-gcp."
echo "  estate: bucket, topic, subscription, secret, service account, Cloud Run service"
echo "  drift : out-of-band storageClass change + undeclared label, both surfaced and remediated"
