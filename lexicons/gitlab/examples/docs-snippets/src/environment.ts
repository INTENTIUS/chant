import * as _ from "./_";

export const productionEnv = new _.Environment({
  name: "production",
  url: "https://example.com",
});

export const deployProd = new _.Job({
  stage: "deploy",
  script: ["npm run deploy"],
  environment: productionEnv,
  rules: [_.onDefaultBranch],
});
