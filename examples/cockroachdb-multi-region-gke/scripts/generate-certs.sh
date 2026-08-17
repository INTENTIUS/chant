#!/usr/bin/env bash
# Generate the one shared CA, the one node cert covering all nine nodes, and
# the root client cert. Nothing else — in particular, NOT the K8s Secrets.
#
# This script used to create `cockroachdb-node-certs` and
# `cockroachdb-client-certs` in each namespace with `kubectl create secret`,
# and that quietly disabled the entire External Secrets path (chant #1724).
# CockroachDbRegionStack declares two ExternalSecrets targeting exactly those
# names with `creationPolicy: Owner`, and ESO will not adopt a Secret it does
# not own: both sat in error forever while the deploy reported success,
# because the Secrets already held the right bytes. Secret Manager, the ESO
# install and the Workload Identity bindings behind it were all decorative.
#
# So the payload goes to Secret Manager (scripts/push-certs.sh) and ESO
# delivers it. The deploy waits for both ExternalSecrets to report
# `SecretSynced` before it waits on any CockroachDB pod, so a broken chain
# fails where it breaks instead of being masked.
#
# The local k3d smoke test is the opposite case and correctly still creates
# the Secrets directly — it does not run ESO at all. See k3d/certs.sh.
set -euo pipefail

CERTS_DIR="${CERTS_DIR:-./certs}"
CRDB_IMAGE="${CRDB_IMAGE:-cockroachdb/cockroach:v24.3.0}"

echo "==> Generating CockroachDB certificates in ${CERTS_DIR}"
mkdir -p "${CERTS_DIR}"

# Generate CA cert
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-ca --certs-dir=/certs --ca-key=/certs/ca.key

# Generate ONE node cert with SANs for ALL 9 nodes + services across all 3 clusters.
# Includes both Cloud DNS names (*.{region}.crdb.internal) and cluster-local names.
echo "==> Generating node cert with all SANs"
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-node \
    cockroachdb-0.east.crdb.internal \
    cockroachdb-1.east.crdb.internal \
    cockroachdb-2.east.crdb.internal \
    cockroachdb-0.central.crdb.internal \
    cockroachdb-1.central.crdb.internal \
    cockroachdb-2.central.crdb.internal \
    cockroachdb-0.west.crdb.internal \
    cockroachdb-1.west.crdb.internal \
    cockroachdb-2.west.crdb.internal \
    cockroachdb-0.cockroachdb.crdb-east.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-east.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-east.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-central.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-central.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-central.svc.cluster.local \
    cockroachdb-0.cockroachdb.crdb-west.svc.cluster.local \
    cockroachdb-1.cockroachdb.crdb-west.svc.cluster.local \
    cockroachdb-2.cockroachdb.crdb-west.svc.cluster.local \
    cockroachdb-0.cockroachdb \
    cockroachdb-1.cockroachdb \
    cockroachdb-2.cockroachdb \
    cockroachdb-public \
    cockroachdb-public.crdb-east \
    cockroachdb-public.crdb-central \
    cockroachdb-public.crdb-west \
    cockroachdb-public.crdb-east.svc.cluster.local \
    cockroachdb-public.crdb-central.svc.cluster.local \
    cockroachdb-public.crdb-west.svc.cluster.local \
    localhost \
    127.0.0.1 \
    --certs-dir=/certs --ca-key=/certs/ca.key

# Generate client cert for root user
docker run --rm -v "${PWD}/${CERTS_DIR}:/certs" "${CRDB_IMAGE}" \
  cert create-client root --certs-dir=/certs --ca-key=/certs/ca.key

echo "==> Certificates generated in ${CERTS_DIR}"
echo "    Next: scripts/push-certs.sh stores them as Secret Manager versions,"
echo "    and External Secrets syncs them into each cluster."
