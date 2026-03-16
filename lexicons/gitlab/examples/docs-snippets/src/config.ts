import { Image, Cache, Artifacts, Rule, Environment, CI } from "@intentius/chant-lexicon-gitlab";

export const nodeImage = new Image({ name: "node:20-alpine" });

export const npmCache = new Cache({
  key: "$CI_COMMIT_REF_SLUG",
  paths: ["node_modules/"],
  policy: "pull-push",
});

export const buildArtifacts = new Artifacts({
  paths: ["dist/"],
  expire_in: "1 hour",
});

export const testArtifacts = new Artifacts({
  paths: ["coverage/"],
  expire_in: "1 week",
  reports: { junit: "coverage/junit.xml" },
});

export const onMergeRequest = new Rule({
  if: CI.MergeRequestIid,
});

export const onCommit = new Rule({
  if: CI.CommitBranch,
});

export const onDefaultBranch = new Rule({
  if: `${CI.CommitBranch} == ${CI.DefaultBranch}`,
  when: "manual",
});

export const productionEnv = new Environment({
  name: "production",
  url: "https://example.com",
});
