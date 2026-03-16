#!/usr/bin/env bash
# Tear down the entire CockroachDB multi-region GKE deployment.
#
# Deletes GKE clusters directly via gcloud (not via Config Connector) to avoid
# the circular dependency of CC running on the management cluster that's being deleted.
set -euo pipefail

GCP_PROJECT_ID="${GCP_PROJECT_ID:?GCP_PROJECT_ID must be set}"

echo "==> Tearing down CockroachDB multi-region GKE cluster"

# Step 1: Delete all 4 GKE clusters in parallel (workload + management).
# Do this first — subnets and VPC can't be deleted while clusters exist.
echo "==> Deleting GKE clusters (parallel)..."
for cluster_region in \
  "gke-crdb-east:us-east4" \
  "gke-crdb-central:us-central1" \
  "gke-crdb-west:us-west1" \
  "gke-crdb-mgmt:us-central1"; do
  cluster="${cluster_region%%:*}"
  region="${cluster_region##*:}"
  gcloud container clusters delete "$cluster" \
    --region "$region" --project "$GCP_PROJECT_ID" --quiet 2>/dev/null \
    && echo "  Deleted $cluster" || echo "  $cluster not found, skipping" &
done
wait
echo "  All GKE clusters deleted"

# Step 2: Delete Cloud DNS zones.
echo "==> Deleting Cloud DNS zones..."
gcloud dns managed-zones list --project "$GCP_PROJECT_ID" \
  --filter="name~crdb" --format="value(name)" 2>/dev/null | \
  while read -r zone; do
    gcloud dns managed-zones delete "$zone" --project "$GCP_PROJECT_ID" --quiet 2>/dev/null \
      && echo "  Deleted DNS zone: $zone" || true
  done

# Step 3: Delete VPC subnets, then the network.
echo "==> Deleting VPC subnets and network..."
for region in us-east4 us-central1 us-west1; do
  gcloud compute networks subnets list \
    --network crdb-multi-region --regions "$region" \
    --project "$GCP_PROJECT_ID" --format="value(name)" 2>/dev/null | \
    xargs -I{} gcloud compute networks subnets delete {} \
      --region "$region" --project "$GCP_PROJECT_ID" --quiet 2>/dev/null &
done
wait
gcloud compute networks delete crdb-multi-region \
  --project "$GCP_PROJECT_ID" --quiet 2>/dev/null && echo "  Deleted VPC" || echo "  VPC not found, skipping"

# Step 4: Delete Cloud Routers.
echo "==> Deleting Cloud Routers..."
for region in us-east4 us-central1 us-west1; do
  gcloud compute routers list \
    --regions "$region" --project "$GCP_PROJECT_ID" \
    --filter="name~crdb-multi-region" --format="value(name)" 2>/dev/null | \
    xargs -I{} gcloud compute routers delete {} \
      --region "$region" --project "$GCP_PROJECT_ID" --quiet 2>/dev/null &
done
wait

# Step 5: Delete GCS backup bucket.
echo "==> Deleting GCS backup bucket..."
gcloud storage rm --recursive "gs://${GCP_PROJECT_ID}-crdb-backups" 2>/dev/null \
  && echo "  Deleted bucket" || echo "  Bucket not found, skipping"

# Step 6: Delete Secret Manager secrets.
echo "==> Deleting Secret Manager secrets..."
for secret in crdb-ca-crt crdb-node-crt crdb-node-key crdb-client-root-crt crdb-client-root-key; do
  gcloud secrets delete "$secret" --project "$GCP_PROJECT_ID" --quiet 2>/dev/null &
done
wait

# Step 7: Delete per-region service accounts (created by Config Connector).
echo "==> Deleting service accounts..."
for sa in \
  "gke-crdb-east-dns" \
  "gke-crdb-central-dns" \
  "gke-crdb-west-dns" \
  "gke-crdb-east-crdb" \
  "gke-crdb-central-crdb" \
  "gke-crdb-west-crdb" \
  "crdb-eso" \
  "config-connector-sa"; do
  gcloud iam service-accounts delete "${sa}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --project "$GCP_PROJECT_ID" --quiet 2>/dev/null \
    && echo "  Deleted $sa" || true &
done
wait

# Step 8: Clean up local certs.
rm -rf certs/

echo ""
echo "NOTE: If you configured DNS delegation at your registrar, the NS records"
echo "now point to deleted zones. Remove them to avoid stale DNS."
echo ""
echo "==> Teardown complete"
