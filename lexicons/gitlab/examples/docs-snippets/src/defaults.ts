import * as _ from "./_";

export const defaults = new _.Default({
  image: new _.Image({ name: "node:20-alpine" }),
  cache: new _.Cache({ key: _.CI.CommitRef, paths: ["node_modules/"] }),
  retry: new _.Retry({ max: 2, when: ["runner_system_failure"] }),
});
