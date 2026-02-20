import * as _ from "./_";

export const workflow = new _.Workflow({
  name: `CI Pipeline for ${_.CI.CommitRef}`,
  rules: [
    new _.Rule({ ifCondition: _.CI.MergeRequestIid }),
    new _.Rule({ ifCondition: _.CI.CommitBranch }),
  ],
  autoCancel: new _.AutoCancel({
    onNewCommit: "interruptible",
  }),
});
