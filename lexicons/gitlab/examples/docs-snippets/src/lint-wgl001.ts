import { Job, Rule, CI } from "@intentius/chant-lexicon-gitlab";

// chant-disable-next-line WGL001
export const deployBad = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  only: ["main"],
});

export const deployGood = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [new Rule({
    ifCondition: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
  })],
});
