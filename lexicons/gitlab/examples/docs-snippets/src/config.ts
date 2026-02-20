import * as _ from "./_";

export const nodeImage = new _.Image({ name: "node:20-alpine" });

export const npmCache = new _.Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});

export const buildArtifacts = new _.Artifacts({
  paths: ["dist/"],
  expireIn: "1 hour",
});

export const testArtifacts = new _.Artifacts({
  paths: ["coverage/"],
  expireIn: "1 week",
  reports: { junit: "coverage/junit.xml" },
});

export const onMergeRequest = new _.Rule({
  ifCondition: _.CI.MergeRequestIid,
});

export const onCommit = new _.Rule({
  ifCondition: _.CI.CommitBranch,
});

export const onDefaultBranch = new _.Rule({
  ifCondition: `${_.CI.CommitBranch} == ${_.CI.DefaultBranch}`,
  when: "manual",
});

export const productionEnv = new _.Environment({
  name: "production",
  url: "https://example.com",
});
