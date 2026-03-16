import { DockerBuild, Job, Image } from "@intentius/chant-lexicon-gitlab";

export const docker = DockerBuild({
  dockerfile: "Dockerfile",
  tagLatest: true,
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:22-alpine" }),
  script: ["node test.js"],
});
