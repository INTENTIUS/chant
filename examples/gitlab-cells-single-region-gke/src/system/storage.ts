import { GcePdStorageClass } from "@intentius/chant-lexicon-k8s";

export const { storageClass: pdSsd } = GcePdStorageClass({
  name: "pd-ssd",
  type: "pd-ssd",
  labels: { "app.kubernetes.io/part-of": "system" },
});
