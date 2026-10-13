// chant #2526 — the ledger fixture's gated Op. The gate comes first, so the
// run stops there (exit 3) and records a pending fact under `_gates/`
// without running anything that needs a cluster.
import { Op, gate, phase, shell } from "@intentius/chant/op";

export default Op({
  name: "hold",
  overview: "A gate, then a shell step, for the level-0 ledger fixture",
  phases: [
    phase("Approve", [gate("go", { timeout: "1h", description: "Approve the level-0 fixture run" })]),
    phase("After", [shell("echo after the gate")]),
  ],
});
