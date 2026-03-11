// GCS backup bucket with lifecycle management and KMS encryption.

import { GcsBucket } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID } from "./config";

export const { bucket: backupBucket } = GcsBucket({
  name: `${GCP_PROJECT_ID}-crdb-backups`,
  location: "US",
  versioning: true,
  kmsKeyName: `projects/${GCP_PROJECT_ID}/locations/us/keyRings/crdb-multi-region/cryptoKeys/crdb-encryption`,
  lifecycleNearlineAfterDays: 30,
  lifecycleDeleteAfterDays: 90,
});
