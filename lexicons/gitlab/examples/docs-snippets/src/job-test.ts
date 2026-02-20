import * as _ from "./_";

export const test = new _.Job({
  stage: "test",
  image: new _.Image({ name: "node:20-alpine" }),
  script: ["npm ci", "npm test"],
  artifacts: new _.Artifacts({
    paths: ["coverage/"],
    expireIn: "1 week",
    reports: { junit: "coverage/junit.xml" },
  }),
});
