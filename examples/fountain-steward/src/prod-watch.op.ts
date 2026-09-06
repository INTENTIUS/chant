// Every quarter hour: snapshot prod and diff it against the declaration.
//
// `schedule` is Op data, not a resource. The Steward in ./fountain.ts reads
// the cron off this Op and turns it into a fountain Schedule on the steward's
// thread, so the cadence is written once and lives with the Op it paces.
//
//   chant run prod-watch                 # here, on the local executor
//   chant run prod-watch --on fountain   # on the steward, as a turn

import { WatchOp } from "@intentius/chant/op";

const { op } = WatchOp({
  name: "prod-watch",
  env: "prod",
  schedule: "*/15 * * * *",
});

export default op;
