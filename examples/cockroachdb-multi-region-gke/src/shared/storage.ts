// GCS backup bucket with lifecycle management and KMS encryption.

import { GcsBucket, IAMPolicyMember } from "@intentius/chant-lexicon-gcp";
import { GCP_PROJECT_ID, GCP_PROJECT_NUMBER } from "./config";

export const { bucket: backupBucket } = GcsBucket({
  name: `${GCP_PROJECT_ID}-crdb-backups`,
  location: "US",
  versioning: true,
  kmsKeyName: `projects/${GCP_PROJECT_ID}/locations/us/keyRings/crdb-multi-region/cryptoKeys/crdb-encryption`,
  lifecycleNearlineAfterDays: 30,
  lifecycleDeleteAfterDays: 90,
});

// Grant the GCS service agent permission to use the KMS key for CMEK.
// The GCS service agent email uses the project number, not the project ID.
export const gcsKmsBinding = new IAMPolicyMember({
  metadata: {
    name: "gcs-kms-encrypter-decrypter",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  member: `serviceAccount:service-${GCP_PROJECT_NUMBER}@gs-project-accounts.iam.gserviceaccount.com`,
  role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
  resourceRef: {
    apiVersion: "kms.cnrm.cloud.google.com/v1beta1",
    kind: "KMSCryptoKey",
    name: "crdb-encryption",
  },
});
