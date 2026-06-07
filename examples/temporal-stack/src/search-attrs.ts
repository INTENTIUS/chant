import { SearchAttribute } from "@intentius/chant-lexicon-temporal";

export const jobTypeAttr = new SearchAttribute({
  name: "JobType",
  type: "Keyword",
  namespace: "my-app",
});

export const priorityAttr = new SearchAttribute({
  name: "Priority",
  type: "Int",
  namespace: "my-app",
});
