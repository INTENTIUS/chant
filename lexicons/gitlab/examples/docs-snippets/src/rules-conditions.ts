import * as _ from "./_";

export const onMergeRequest = new _.Rule({
  ifCondition: _.CI.MergeRequestIid,
});

export const onDefaultBranch = new _.Rule({
  ifCondition: `${_.CI.CommitBranch} == ${_.CI.DefaultBranch}`,
  when: "manual",
});

export const deployJob = new _.Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [onDefaultBranch],
});
