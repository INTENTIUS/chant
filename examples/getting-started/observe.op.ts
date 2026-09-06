// L4 — the lifecycle dial, position 1: observe.
//
// WatchOp builds a snapshot+diff Op and puts the cron on the Op itself, so chant
// checks the live cluster against your declarations on a cadence and reports
// drift. It changes nothing — this is the read-only end of the dial.
//
// Who honours the cron is the runtime's business: `chant operator` ticks this Op
// on it, a CI generator renders it as a pipeline schedule, and a fountain
// steward turns it into a Schedule on the teammate's thread. A bare
// `chant run observe` is still one observation, now.
//
//   chant build && chant run observe
import { WatchOp } from "@intentius/chant/op";

export const { op } = WatchOp({
  name: "observe",
  env: "local",
  schedule: "0 * * * *", // hourly
  live: true, // query the cluster, not just a digest
});

export default op;
