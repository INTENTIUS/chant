// Every quarter hour: snapshot prod and diff it against the declaration.
//
// `schedule` is Op data, not a resource. The Steward in ./fountain.ts lists
// this Op, and a clock outside Managoat (a CI schedule or a CronJob that runs
// `chant run prod-watch --on fountain`) fires it on this cron, so the cadence
// is written once and lives with the Op it paces.
//
//   chant run prod-watch                 # here, on the local executor
//   chant run prod-watch --on fountain   # on the steward, as a turn

import { WatchOp } from "@intentius/chant/op";

// Exported by name, not as the default. `chant run` finds either (#2171), and a
// named export is the one of the two the fold path can reduce: a file with an
// `export default` always falls back to running, and so does every file that
// imports it, which used to cost this example its fold coverage entirely.
export const { op: prodWatch } = WatchOp({
  name: "prod-watch",
  env: "prod",
  schedule: "*/15 * * * *",
});
