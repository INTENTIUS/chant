import { Job, Image, Artifacts } from "@intentius/chant-lexicon-gitlab";

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20-alpine" }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
    reports: { junit: "coverage/junit.xml" },
  }),
});
