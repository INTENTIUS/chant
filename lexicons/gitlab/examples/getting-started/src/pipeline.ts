import { Job } from "@intentius/chant-lexicon-gitlab";
import {
  nodeImage,
  npmCache,
  buildArtifacts,
  testArtifacts,
  onMergeRequest,
  onCommit,
  onDefaultBranch,
  productionEnv,
} from "./config";

export const build = new Job({
  stage: "build",
  image: nodeImage,
  cache: npmCache,
  script: ["npm ci", "npm run build"],
  artifacts: buildArtifacts,
});

export const test = new Job({
  stage: "test",
  image: nodeImage,
  cache: npmCache,
  script: ["npm ci", "npm test"],
  artifacts: testArtifacts,
  rules: [onMergeRequest, onCommit],
});

export const deploy = new Job({
  stage: "deploy",
  image: nodeImage,
  script: ["npm run deploy"],
  environment: productionEnv,
  rules: [onDefaultBranch],
});
