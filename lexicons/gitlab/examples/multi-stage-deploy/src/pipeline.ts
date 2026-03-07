import { Job, Image, Cache, Environment, Rule } from "@intentius/chant-lexicon-gitlab";

const nodeImage = new Image({ name: "node:22-alpine" });

const npmCache = new Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});

export const build = new Job({
  stage: "build",
  image: nodeImage,
  cache: npmCache,
  script: ["npm install", "npm run build"],
});

export const test = new Job({
  stage: "test",
  image: nodeImage,
  cache: npmCache,
  script: ["npm install", "npm test"],
});

export const deployStagingJob = new Job({
  _name: "deploy-staging",
  stage: "deploy",
  image: nodeImage,
  script: ["npm install", "npm run deploy -- --env staging"],
  environment: new Environment({
    name: "staging",
    url: "https://staging.example.com",
  }),
  rules: [
    new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
  ],
});

export const deployProductionJob = new Job({
  _name: "deploy-production",
  stage: "deploy",
  image: nodeImage,
  script: ["npm install", "npm run deploy -- --env production"],
  environment: new Environment({
    name: "production",
    url: "https://example.com",
  }),
  rules: [
    new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", when: "manual" }),
  ],
});
