import { Job, Artifacts } from "@intentius/chant-lexicon-gitlab";
import { defaultImage, npmCache } from "./config";

export const junitReports = { junit: "coverage/junit.xml" };

export const testArtifacts = new Artifacts({
  reports: junitReports,
  paths: ["coverage/"],
  expire_in: "1 week",
});

export const build = new Job({
  stage: "build",
  image: defaultImage,
  cache: npmCache,
  script: ["npm install", "npm run build"],
});

export const test = new Job({
  stage: "test",
  image: defaultImage,
  cache: npmCache,
  script: ["npm install", "npm test"],
  artifacts: testArtifacts,
});
