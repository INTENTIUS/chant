// L3 — a human-approval gate, on Temporal.
//
// Same declarations again. This Op inserts an approval gate before the apply,
// and adds a rollback that runs if anything fails. A gate is a durable
// wait-for-signal: it can hold for hours without keeping a process open and
// survives a worker restart — so this Op needs `--temporal`, not the local
// executor (the local executor errors on a gate, by design).
//
//   chant run deploy-gated --temporal        # pauses at "Approve"
//   chant run signal deploy-gated approve-deploy   # releases it
//
// L2's `deploy` stays the fast local path; this is the gated production shape.
import { Op, phase, build, kubectlApply, gate, shell } from "@intentius/chant-lexicon-temporal";

export default Op({
  name: "deploy-gated",
  overview: "Build, pause for human approval, then apply — durable on Temporal",
  taskQueue: "getting-started-deploy",
  phases: [
    // Paths are relative to the example dir (where `chant run` is invoked).
    phase("Build", [build(".")]),
    phase("Approve", [
      gate("approve-deploy", {
        timeout: "24h",
        description: "Approve applying the getting-started manifests to the cluster",
      }),
    ]),
    phase("Apply", [kubectlApply("k8s.yaml")]),
  ],
  onFailure: [
    phase("Rollback", [
      shell("kubectl delete -f k8s.yaml --ignore-not-found"),
    ]),
  ],
});
