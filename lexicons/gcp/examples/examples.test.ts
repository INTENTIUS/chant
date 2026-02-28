import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { gcpSerializer } from "@intentius/chant-lexicon-gcp";

describeAllExamples(
  {
    lexicon: "gcp",
    serializer: gcpSerializer,
    outputKey: "gcp",
    examplesDir: import.meta.dir,
  },
  {
    // These examples use hardcoded regions for simplicity (WGC002 warnings)
    "vpc-network": { skipLint: true },
    "gke-cluster": { skipLint: true },
  },
);
