import { ReviewApp, Job, Image } from "@intentius/chant-lexicon-gitlab";

export const review = ReviewApp({
  name: "review",
  deployScript: "echo deploy",
});

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:22-alpine" }),
  script: ["node test.js"],
});
