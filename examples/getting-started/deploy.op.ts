// L2 — Ops, on the local executor.
//
// The same L1 declarations, now wrapped in an Op: a named, phased workflow.
// `chant run deploy` runs this in-process with no Temporal server — it builds
// the manifests, then applies them to your current kube context (point that at a
// local k3d cluster). Phases run in order, and a failing step retries per its
// profile. Reach for `--temporal` only when you need gates, schedules, or
// crash-resume (that is L3).
import { Op, phase, build, kubectlApply } from "@intentius/chant-lexicon-temporal";

export default Op({
  name: "deploy",
  overview: "Build the getting-started manifests and apply them to the current kube context",
  taskQueue: "getting-started-deploy",
  phases: [
    // Runs `npm run build` in the example → writes k8s.yaml.
    phase("Build", [build("examples/getting-started")]),
    // kubectl apply -f against the current context (e.g. local k3d).
    phase("Apply", [kubectlApply("examples/getting-started/k8s.yaml")]),
  ],
});
