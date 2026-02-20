import * as _ from "./_";

export const api = _.propagate(
  _.$.healthApi,
  { tags: [{ key: "env", value: "prod" }] },
);
