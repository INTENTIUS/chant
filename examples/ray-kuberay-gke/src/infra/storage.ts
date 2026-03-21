// GCS spillover bucket + Artifact Registry for Ray images.
//
// GCS bucket: receives large object store spills from the Ray head node
// (model weights, shuffled datasets). 7-day lifecycle auto-expires orphaned files.
//
// Artifact Registry: stores pre-built Ray images. Pre-built images avoid
// per-worker pip-install startup latency (adds minutes at scale).

import { GcsBucket, ArtifactRegistryRepository } from "@intentius/chant-lexicon-gcp";
import { config } from "../config";

// ── GCS Spillover Bucket ─────────────────────────────────────────────────

export const { bucket: spilloverBucket } = GcsBucket({
  name: config.spilloverBucketName,
  location: config.region,
  storageClass: "STANDARD",
  lifecycleDeleteAfterDays: 7,
});

// ── Artifact Registry ─────────────────────────────────────────────────────

export const rayRegistry = new ArtifactRegistryRepository({
  metadata: {
    name: config.registryName,
    annotations: {
      "cnrm.cloud.google.com/project-id": config.projectId,
    },
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: config.region,
  format: "DOCKER",
  description: "Pre-built Ray images for KubeRay workers",
});
