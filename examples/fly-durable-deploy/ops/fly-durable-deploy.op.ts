import { Op, phase, build } from "@intentius/chant/op";
import { flyApplyStep } from "@intentius/chant-lexicon-fly";

/**
 * Deploy the Fly App + Machine (src/infra.ts) on a cadence, from a steward's
 * own machine.
 *
 * Build serializes src/infra.ts to the flaps plan; Deploy applies it straight
 * to the Machines API (flyApply waits each machine to `started`). Both steps
 * are convergent: applying the same plan twice reaches the same App and the
 * same Machine, so a re-run is a correction rather than a second deploy. That
 * is what makes the cadence below safe to leave running.
 *
 * `schedule` is Op data, not a resource. The Steward in ./fountain.ts
 * reads this cron and turns it into a fountain Schedule on the steward's
 * thread, so the cadence is written once, next to the Op it paces.
 *
 *   chant run fly-durable-deploy                 # here, on the local executor
 *   chant run fly-durable-deploy --on fountain   # on the steward, as a turn
 *
 * The flaps endpoint comes from FLY_FLAPS_BASE_URL — local mudflaps offline,
 * real Fly (with FLY_API_TOKEN) when unset.
 */
export default Op({
  name: "fly-durable-deploy",
  overview: "Deploy the Fly App + Machine, convergently, on a cadence",
  schedule: { cron: "*/30 * * * *" },
  phases: [
    phase("Build", [build(".", { script: "build:fly" })]),
    phase("Deploy", [flyApplyStep("dist/fly.json")]),
  ],
});
