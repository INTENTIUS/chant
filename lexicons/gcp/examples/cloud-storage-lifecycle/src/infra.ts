/**
 * Cloud Storage bucket with lifecycle rules for tiered storage management.
 *
 * Objects transition from STANDARD -> NEARLINE -> COLDLINE -> ARCHIVE,
 * and are deleted after 5 years.
 */

import { StorageBucket, GCP, defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const bucket = new StorageBucket({
  metadata: {
    name: "data-archive-bucket",
    labels: {
      "app.kubernetes.io/managed-by": "chant",
      purpose: "data-archive",
    },
  },
  location: "US",
  storageClass: "STANDARD",
  uniformBucketLevelAccess: true,
  versioning: { enabled: true },
  softDeletePolicy: { retentionDurationSeconds: 604800 },
  retentionPolicy: {
    isLocked: false,
    retentionPeriod: 2592000,
  },
  lifecycleRule: [
    {
      action: { type: "SetStorageClass", storageClass: "NEARLINE" },
      condition: { age: 30 },
    },
    {
      action: { type: "SetStorageClass", storageClass: "COLDLINE" },
      condition: { age: 90 },
    },
    {
      action: { type: "SetStorageClass", storageClass: "ARCHIVE" },
      condition: { age: 365 },
    },
    {
      action: { type: "Delete" },
      condition: { age: 1825 },
    },
    {
      action: { type: "Delete" },
      condition: { numNewerVersions: 3, withState: "ARCHIVED" },
    },
  ],
});
