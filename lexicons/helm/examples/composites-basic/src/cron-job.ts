import { HelmCronJob } from "@intentius/chant-lexicon-helm";

export const { chart, values, cronJob } = HelmCronJob({
  name: "nightly-cleanup",
  imageRepository: "alpine",
  imageTag: "3.19",
  schedule: "0 2 * * *",
});
