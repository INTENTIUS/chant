import * as _ from "./_";

export const build = new _.Job({
  stage: "build",
  image: _.nodeImage,
  cache: _.npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: _.buildArtifacts,
});

export const test = new _.Job({
  stage: "test",
  image: _.nodeImage,
  cache: _.npmCache,
  script: ["npm ci", "npm test"],
  artifacts: _.testArtifacts,
  rules: [_.onMergeRequest, _.onCommit],
});

export const deploy = new _.Job({
  stage: "deploy",
  image: _.nodeImage,
  script: ["npm run deploy"],
  environment: _.productionEnv,
  rules: [_.onDefaultBranch],
});
