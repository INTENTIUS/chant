// Hourly, on the observe dial: report what has drifted and act on nothing.
//
// Every rule carries its why, and the dial is the authority the environment
// grants. Turning it to `reconcile` or `apply` is a separate, reviewable edit
// rather than something a rule can decide for itself.

import { ConvergeOp, gt, report, when } from "@intentius/chant/op";

const { op } = ConvergeOp({
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

export default op;
