import { factoryOp } from "@intentius/chant/op";

// The factory reference Op (#3406, ws-087): chant's rules for which work item
// is built next, how its tier and the understand point are asked, and what
// done means; this workspace supplies only execution, as hooks. These stubs
// stand in for an orchestrator's: a real builder runs an agent in the worktree.
//
//   chant run factory
export const factory = factoryOp({
  builder: "node delivery/factory/builder.mjs",
  check: "node delivery/factory/check.mjs",
});
