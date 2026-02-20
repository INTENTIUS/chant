import * as _ from "./_";

// Use in rule conditions
export const onDefault = new _.Rule({
  ifCondition: `${_.CI.CommitBranch} == ${_.CI.DefaultBranch}`,
});

// Use in cache keys
export const cache = new _.Cache({
  key: _.CI.CommitRef,
  paths: ["node_modules/"],
});
