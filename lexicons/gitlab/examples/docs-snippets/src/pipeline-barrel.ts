import * as _ from "./_";

export const build = new _.Job({
  stage: "build",
  image: _.nodeImage,
  cache: _.npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: _.buildArtifacts,
});
