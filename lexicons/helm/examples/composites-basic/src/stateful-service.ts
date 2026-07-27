import { HelmStatefulService } from "@intentius/chant-lexicon-helm";

export const {
  chart: ssChart,
  values: ssValues,
  statefulSet: ssStatefulSet,
  service: ssService,
} = HelmStatefulService({
  name: "postgres",
  imageRepository: "postgres",
  imageTag: "16",
  port: 5432,
  storageSize: "20Gi",
  storageClass: "gp3",
});
