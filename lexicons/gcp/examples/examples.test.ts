import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { gcpSerializer } from "@intentius/chant-lexicon-gcp";

// cloud-function, cloud-run and cloud-sql read GCP.ProjectId and GCP.Region,
// which a build resolves from these variables (#4200).
process.env.GCP_PROJECT_ID ??= "example-project";
process.env.GCP_REGION ??= "us-central1";

describeAllExamples(
  {
    lexicon: "gcp",
    serializer: gcpSerializer,
    outputKey: "gcp",
    examplesDir: import.meta.dirname,
  },
  {
    // These examples use hardcoded regions for simplicity (WGC002 warnings)
    "vpc-network": { skipLint: true },
    "gke-cluster": { skipLint: true },
    "cloud-run": { skipLint: true },
    "pubsub": { skipLint: true },
    "cloud-storage-lifecycle": { skipLint: true },
  },
);
