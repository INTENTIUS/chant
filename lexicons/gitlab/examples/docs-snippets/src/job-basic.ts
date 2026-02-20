import * as _ from "./_";

export const buildApp = new _.Job({
  stage: "build",
  image: new _.Image({ name: "node:20" }),
  script: ["npm ci", "npm run build"],
});
