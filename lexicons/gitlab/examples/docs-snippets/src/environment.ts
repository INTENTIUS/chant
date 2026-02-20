import { Environment, Job } from "@intentius/chant-lexicon-gitlab";
import { onDefaultBranch } from "./config";

export const productionEnv = new Environment({
  name: "production",
  url: "https://example.com",
});

export const deployProd = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  environment: productionEnv,
  rules: [onDefaultBranch],
});
