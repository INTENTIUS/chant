/**
 * GCS Bucket with uniform access, versioning, and lifecycle rule.
 */

import { StorageBucket, GCP, defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const bucket = new StorageBucket({
  metadata: {
    name: "my-data-bucket",
    labels: {
      "app.kubernetes.io/managed-by": "chant",
    },
  },
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
  lifecycleRule: [
    { action: { type: "Delete" }, condition: { age: 365 } },
  ],
});
