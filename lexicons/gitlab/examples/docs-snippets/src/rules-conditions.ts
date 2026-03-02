import { Rule, Job, CI } from "@intentius/chant-lexicon-gitlab";

export const mrRule = new Rule({
  if: CI.MergeRequestIid,
});

export const defaultBranchRule = new Rule({
  if: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
  when: "manual",
});

export const deployJob = new Job({
  stage: "deploy",
  script: ["npm run deploy"],
  rules: [defaultBranchRule],
});
