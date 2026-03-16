import { Job, Image } from "@intentius/chant-lexicon-gitlab";

export const buildApp = new Job({
  stage: "build",
  image: new Image({ name: "node:20" }),
  script: ["npm ci", "npm run build"],
});
