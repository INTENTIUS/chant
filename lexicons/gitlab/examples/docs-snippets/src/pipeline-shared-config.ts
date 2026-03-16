import { Job } from "@intentius/chant-lexicon-gitlab";
import { nodeImage, npmCache, buildArtifacts } from "./config";

export const build = new Job({
  stage: "build",
  image: nodeImage,
  cache: npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: buildArtifacts,
});
