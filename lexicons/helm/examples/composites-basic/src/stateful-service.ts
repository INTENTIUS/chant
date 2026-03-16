import { HelmStatefulService } from "@intentius/chant-lexicon-helm";

export const { chart, values, statefulSet, service } = HelmStatefulService({
  name: "postgres",
  imageRepository: "postgres",
  imageTag: "16",
  port: 5432,
  storageSize: "20Gi",
  storageClass: "gp3",
});
