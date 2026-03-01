// Namespace for web platform workloads.

import { Namespace } from "@intentius/chant-lexicon-k8s";

export const namespace = new Namespace({
  metadata: {
    name: "web-platform",
    labels: {
      "app.kubernetes.io/managed-by": "chant",
      "app.kubernetes.io/part-of": "web-platform",
    },
  },
});
