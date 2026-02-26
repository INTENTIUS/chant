// Namespace for batch processing workloads.

import { Namespace } from "@intentius/chant-lexicon-k8s";

export const namespace = new Namespace({
  metadata: {
    name: "batch-workers",
    labels: {
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/part-of": "batch-workers",
    },
  },
});
