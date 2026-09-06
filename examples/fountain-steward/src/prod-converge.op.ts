// Hourly, on the observe dial: report what has drifted and act on nothing.
//
// Every rule carries its why, and the dial is the authority the environment
// grants. Turning it to `reconcile` or `apply` is a separate, reviewable edit
// rather than something a rule can decide for itself.

import { ConvergeOp, gt, report, when } from "@intentius/chant/op";

// Exported by name, not as the default. `chant run` finds either (#2171), and a
// named export is the one of the two the fold path can reduce: a file with an
// `export default` always falls back to running, and so does every file that
// imports it, which used to cost this example its fold coverage entirely.
export const { op: prodConverge } = ConvergeOp({
  name: "prod-converge",
  env: "prod",
  dial: "observe",
  schedule: "0 * * * *",
  rules: [
    when(gt("updateCount", 0), report("declared and live state disagree"), {
      id: "prod-drift",
      why: "An update pending against prod means something changed outside this repo; say so before anything acts on it.",
    }),
  ],
});
