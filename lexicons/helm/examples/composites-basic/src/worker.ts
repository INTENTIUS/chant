import { HelmWorker } from "@intentius/chant-lexicon-helm";

export const { chart, values, deployment, serviceAccount, hpa, pdb } = HelmWorker({
  name: "queue-processor",
  imageRepository: "myorg/worker",
  replicas: 3,
  autoscaling: true,
});
