import { Rule, Job, CI } from "@intentius/chant-lexicon-gitlab";

export const onMergeRequest = new Rule({
  if: CI.MergeRequestIid,
});

export const onDefaultBranch = new Rule({
  if: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
  when: "manual",
});

export const deployJob = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [onDefaultBranch],
});
