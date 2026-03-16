import { Default, Image, Cache, Retry, CI } from "@intentius/chant-lexicon-gitlab";

export const defaults = new Default({
  image: new Image({ name: "node:20-alpine" }),
  cache: new Cache({ key: CI.CommitRef, paths: ["node_modules/"] }),
  retry: new Retry({ max: 2, when: ["runner_system_failure"] }),
});
