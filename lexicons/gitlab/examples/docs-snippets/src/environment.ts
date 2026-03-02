import { Environment, Job } from "@intentius/chant-lexicon-gitlab";
import { onDefaultBranch } from "./config";

export const prodEnv = new Environment({
  name: "production",
  url: "https://example.com",
});

export const deployProd = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  environment: prodEnv,
  rules: [onDefaultBranch],
});
