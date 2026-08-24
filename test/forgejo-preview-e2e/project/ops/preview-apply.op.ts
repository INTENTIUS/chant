// The deploy verb the on-open job runs: build the plan for the resolved env,
// then apply it through flyApply (direct Machines API, waits each machine to
// `started`). Runs on the local Op executor — no Temporal server. The
// endpoint comes from the ambient FLY_FLAPS_BASE_URL the workflow sets, so
// the same op targets real flaps by dropping that variable.

import { Op, phase, activity, build } from "@intentius/chant-lexicon-temporal";
import { params } from "@intentius/chant/params";

export default Op({
  name: "preview-apply",
  overview: "build → flyApply: deploy one PR's preview copy to the env's flaps endpoint",
  taskQueue: "preview-apply",
  phases: [
    phase("Build", [build(".")]),
    phase("Apply", [
      activity(
        "nativeApply",
        { target: "fly", env: params.env as string, output: "dist/fly.json" },
        "longInfra",
      ),
    ]),
  ],
});
