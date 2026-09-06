// L3 — a human-approval gate, on the same local executor as L2.
//
// Same declarations again. This Op inserts an approval gate before the apply,
// and adds a rollback that runs if anything fails. A gate is a fact, not a
// wait: the run reads the gate ledger for a resolution someone recorded, and
// either walks through carrying the approver or writes a pending fact and
// ends. Nothing is held open, so no runtime beyond this process is involved.
//
//   chant run deploy-gated                                  # ends "gated", exit 3
//   chant approve deploy-gated approve-deploy --approver you
//   chant run deploy-gated                                  # walks through, applies
//
// Exit 3 is its own code so a CI job can tell "waiting on a person" from a
// broken op and retry one without retrying the other. L2's `deploy` stays the
// ungated path; this is the shape a production apply takes.
import { Op, phase, build, gate, shell } from "@intentius/chant/op";
import { kubectlApply } from "@intentius/chant-lexicon-k8s/op/builders";

export default Op({
  name: "deploy-gated",
  overview: "Build, pause for human approval, then apply",
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
