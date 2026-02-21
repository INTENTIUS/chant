import { Workflow, Rule, AutoCancel, CI } from "@intentius/chant-lexicon-gitlab";

export const workflow = new Workflow({
  name: `CI Pipeline for ${CI.CommitRef}`,
  rules: [
    new Rule({ if: CI.MergeRequestIid }),
    new Rule({ if: CI.CommitBranch }),
  ],
  auto_cancel: new AutoCancel({
    on_new_commit: "interruptible",
  }),
});
