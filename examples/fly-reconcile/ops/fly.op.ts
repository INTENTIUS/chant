import { Op, phase, build } from "@intentius/chant/op";
import { flyApplyStep } from "@intentius/chant-lexicon-fly";

/**
 * Reconcile the app + volume + two machines against a **running** mudflaps —
 * `chant run fly`. Unlike the local-fly deploy Op, this one does not boot or tear
 * down the emulator: you start mudflaps once and run this repeatedly, so the
 * state persists across runs and the reconcile is observable (re-apply no-op,
 * in-place update, owned-only prune).
 *
 *   docker run -d --rm -p 4280:4280 --name mudflaps ghcr.io/intentius/mudflaps:0.4.0
 *
 * `flyApply` GET-then-creates each resource, updates changed machines in place,
 * and — with `prune: true` — destroys chant-owned machines no longer declared. A
 * machine created directly in mudflaps (no `managed-by: chant` marker) is left
 * untouched. To target real Fly, drop the `endpoint` override and set
 * `FLY_FLAPS_BASE_URL` / `FLY_API_TOKEN`.
 */
export default Op({
  name: "fly",
  overview: "Reconcile the plan against a running mudflaps (create / update / prune)",
  taskQueue: "fly",
  phases: [
    phase("Build", [build(".", { script: "build:fly" })]),
    phase("Apply", [flyApplyStep("dist/fly.json", { endpoint: "http://localhost:4280", prune: true })]),
  ],
});
