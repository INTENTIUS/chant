import { HelmWorker } from "@intentius/chant-lexicon-helm";

export const {
  chart: wkChart,
  values: wkValues,
  deployment: wkDeployment,
  serviceAccount: wkSa,
  hpa: wkHpa,
  pdb: wkPdb,
} = HelmWorker({
  name: "queue-processor",
  imageRepository: "myorg/worker",
  replicas: 3,
  autoscaling: true,
});
