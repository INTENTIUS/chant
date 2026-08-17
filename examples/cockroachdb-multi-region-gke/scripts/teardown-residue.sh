#!/usr/bin/env bash
# What Config Connector does not own.
#
# The GCS bucket has objects and the Secret Manager entries have versions, so
# neither deletes cleanly by removing the manifest. The management cluster was
# created by scripts/bootstrap.sh, imperatively, and so is its service account.
#
# Idempotent: everything already gone is fine.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"

echo "==> backup bucket contents"
gcloud storage rm --recursive "gs://${project_id}-crdb-backups" 2>/dev/null || true

echo "==> secret manager entries"
for secret in crdb-ca-crt crdb-node-crt crdb-node-key crdb-client-root-crt crdb-client-root-key; do
  gcloud secrets delete "${secret}" --project "${project_id}" --quiet 2>/dev/null || true
done

echo "==> management cluster"
gcloud container clusters delete gke-crdb-mgmt \
  --region us-central1 --project "${project_id}" --quiet 2>/dev/null || true

echo "==> config connector service account"
cc_sa="config-connector-sa@${project_id}.iam.gserviceaccount.com"
for role in roles/editor roles/iam.securityAdmin roles/dns.admin \
            roles/cloudkms.admin roles/secretmanager.admin; do
  gcloud projects remove-iam-policy-binding "${project_id}" \
    --member "serviceAccount:${cc_sa}" --role "$role" --quiet 2>/dev/null || true
done
gcloud iam service-accounts delete "${cc_sa}" --project "${project_id}" --quiet 2>/dev/null || true

echo "==> local certs"
rm -rf certs/

echo ""
echo "Teardown complete."
echo "If you delegated DNS subdomains at your registrar, the NS records now"
echo "point at deleted zones — remove them."
