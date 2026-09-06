// L2 — Ops, on the local executor.
//
// The same L1 declarations, now wrapped in an Op: a named, phased workflow.
// `chant run deploy` runs this in-process — it builds the manifests, then
// applies them to your current kube context (point that at a local k3d
// cluster). Phases run in order, and a failing step retries per its profile.
// L3 adds the approval gate; nothing else about the shape changes.
import { Op, phase, build } from "@intentius/chant/op";
import { kubectlApply } from "@intentius/chant-lexicon-k8s/op/builders";

export default Op({
  name: "deploy",
  overview: "Build the getting-started manifests and apply them to the current kube context",
  phases: [
    // Runs `npm run build` in this example dir → writes k8s.yaml. Paths are
    // relative to where `chant run` is invoked (the example dir), hence `.`.
    phase("Build", [build(".")]),
    // kubectl apply -f against the current context (e.g. local k3d).
    phase("Apply", [kubectlApply("k8s.yaml")]),
  ],
});
