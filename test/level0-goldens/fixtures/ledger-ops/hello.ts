// chant #2526 — the ledger fixture's ungated Op. One shell step, so a local
// run finishes without a cluster and writes its run record to the ledger.
import { Op, phase, shell } from "@intentius/chant/op";

export default Op({
  name: "hello",
  overview: "One shell step, for the level-0 ledger fixture",
  phases: [phase("Greet", [shell("echo hello from the level-0 fixture")])],
});
