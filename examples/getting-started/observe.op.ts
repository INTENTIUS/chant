// L4 — the lifecycle dial, position 1: observe.
//
// WatchOp pairs a snapshot+diff Op with a Temporal schedule, so chant checks the
// live cluster against your declarations on a cron and reports drift. It changes
// nothing — this is the read-only end of the dial. Schedules need Temporal.
//
//   chant build && chant run observe --temporal
import { WatchOp } from "@intentius/chant-lexicon-temporal";

const watch = WatchOp({
  name: "observe",
  env: "local",
  schedule: "0 * * * *", // hourly
  live: true, // query the cluster, not just a digest
});

export default watch.op;
export const schedule = watch.schedule;
