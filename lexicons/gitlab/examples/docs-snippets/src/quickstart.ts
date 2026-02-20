import { Job, Image, Cache, Artifacts, CI } from "@intentius/chant-lexicon-gitlab";

export const test = new Job({
  stage: "test",
  image: new Image({ name: "node:20" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"] }),
  script: ["npm ci", "npm test"],
  artifacts: new Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
  }),
});
