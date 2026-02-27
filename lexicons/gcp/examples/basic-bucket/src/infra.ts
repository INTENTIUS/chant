/**
 * GCS Bucket with uniform access, versioning, and IAM binding.
 */

import { GcsBucket, IAMPolicyMember, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const { bucket } = GcsBucket({
  name: "my-data-bucket",
  location: "US",
  versioning: true,
  uniformBucketLevelAccess: true,
  lifecycleDeleteAfterDays: 365,
});
