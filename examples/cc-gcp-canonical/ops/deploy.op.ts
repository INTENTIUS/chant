import { Op, phase, build, gcpApply } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the estate to floci-gcp via `gcpApply`. `chant run cc-gcp-deploy`.
 *
 * GCP has no native deployment service to shell out to, so gcpApply maps each
 * kind to its REST API itself (direct REST, per-resource, cluster-free). The
 * emulator is NOT booted here — the CC e2e (test/gcp-cc-e2e.sh) owns its
 * lifecycle so the estate outlives the apply and can be observed and drifted
 * against; boot one yourself with `chant emulator up --lexicon gcp`.
 */
export default Op({
  name: "cc-gcp-deploy",
  overview: "GCP: the CC canonical estate → floci-gcp (direct REST apply), local, no account",
  taskQueue: "cc-gcp",
  phases: [
    phase("Build", [build(".", { script: "build" })]),
    phase("Apply", [gcpApply("dist/gcp.yaml", { endpoint: "http://localhost:4588", project: "local-project" })]),
  ],
});
