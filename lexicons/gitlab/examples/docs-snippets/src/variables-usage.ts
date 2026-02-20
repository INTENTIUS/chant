import { Rule, Cache, CI } from "@intentius/chant-lexicon-gitlab";

// Use in rule conditions
export const onDefault = new Rule({
  ifCondition: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
});

// Use in cache keys
export const cache = new Cache({
  key: CI.CommitRef,
  paths: ["node_modules/"],
});
