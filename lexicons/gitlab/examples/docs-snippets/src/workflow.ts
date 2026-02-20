import { Workflow, Rule, AutoCancel, CI } from "@intentius/chant-lexicon-gitlab";

export const workflow = new Workflow({
  name: `CI Pipeline for ${CI.CommitRef}`,
  rules: [
    new Rule({ ifCondition: CI.MergeRequestIid }),
    new Rule({ ifCondition: CI.CommitBranch }),
  ],
  autoCancel: new AutoCancel({
    onNewCommit: "interruptible",
  }),
});
