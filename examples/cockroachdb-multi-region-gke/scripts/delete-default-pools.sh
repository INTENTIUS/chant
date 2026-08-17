#!/usr/bin/env bash
# GKE insists on creating a default-pool alongside the managed pool chant
# declares. Once the managed pool is RUNNING the default one is dead weight and
# holds CPU quota this project needs for nine CockroachDB nodes.
#
# Run only after the managed pools report ready — the deploy Op waits on the
# ContainerNodePool resources first.
#
# Idempotent: a pool that is already gone is not an error.
set -euo pipefail

project_id="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"

for entry in "gke-crdb-east:us-east4" \
             "gke-crdb-central:us-central1" \
             "gke-crdb-west:us-west1"; do
  cluster="${entry%%:*}"
  region="${entry#*:}"
  echo "==> deleting default-pool from ${cluster}"
  gcloud container node-pools delete default-pool \
    --cluster "${cluster}" --region "${region}" \
    --project "${project_id}" --quiet 2>/dev/null || true
done
