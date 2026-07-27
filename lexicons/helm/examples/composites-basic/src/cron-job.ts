import { HelmCronJob } from "@intentius/chant-lexicon-helm";

export const { chart: cronChart, values: cronValues, cronJob } = HelmCronJob({
  name: "nightly-cleanup",
  imageRepository: "alpine",
  imageTag: "3.19",
  schedule: "0 2 * * *",
});
