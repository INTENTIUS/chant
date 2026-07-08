import { StorageBucket, defaultAnnotations } from "@intentius/chant-lexicon-gcp";

// GCP object store — a GCS bucket. Synthesizes to a Config Connector manifest,
// deployed to floci-gcp via `gcpApply` (direct GCS REST, since GCP has no native
// deployment service to shell out to).
export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": "local-project",
});

export const bucket = new StorageBucket({
  metadata: {
    name: "trio-bucket",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
});
