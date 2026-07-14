import { Op, phase, build } from "@intentius/chant-lexicon-temporal";
import { flyApplyStep } from "@intentius/chant-lexicon-fly";

/**
 * Durably deploy the Fly App + Machine (src/infra.ts) on Temporal. `chant build`
 * generates the worker under dist/ops/fly-durable-deploy/; `chant run
 * fly-durable-deploy --temporal` auto-starts a local Temporal server, spawns the
 * worker, and runs the deploy as a durable workflow — kill and restart the
 * worker and it resumes from Temporal's persisted state.
 *
 * Build serializes src/infra.ts to the flaps plan; Deploy applies it straight to
 * the Machines API (flyApply waits each machine to `started`). The flaps endpoint
 * comes from FLY_FLAPS_BASE_URL — local mudflaps offline, real Fly (with
 * FLY_API_TOKEN) when unset.
 */
export default Op({
  name: "fly-durable-deploy",
  overview: "Durably deploy the Fly App + Machine on Temporal",
  taskQueue: "fly-durable",
  phases: [
    phase("Build", [build(".", { script: "build:fly" })]),
    phase("Deploy", [flyApplyStep("dist/fly.json")]),
  ],
});
