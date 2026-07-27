import { SearchAttribute } from "@intentius/chant-lexicon-temporal";

/**
 * A custom search attribute scoped to the "my-app" namespace, so workflows
 * can be queried by job type from the Temporal Web UI or `temporal workflow list`.
 */
export const jobTypeAttr = new SearchAttribute({
  name: "JobType",
  type: "Keyword",
  namespace: "my-app",
});
