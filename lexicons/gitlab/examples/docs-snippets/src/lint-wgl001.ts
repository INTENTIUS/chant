import * as _ from "./_";

// chant-disable-next-line WGL001
export const deployBad = new _.Job({
  stage: "deploy",
  script: ["npm run deploy"],
  only: ["main"],
});

export const deployGood = new _.Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [new _.Rule({
    ifCondition: `${_.CI.CommitBranch} == ${_.CI.DefaultBranch}`,
  })],
});
