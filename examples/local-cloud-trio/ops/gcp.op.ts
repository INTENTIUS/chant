import { Op, phase, build, gcpApply, flociGcpUp, flociGcpDown, httpCheck } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the GCS bucket to a local floci-gcp via `gcpApply`. `chant run gcp`.
 * Requires Docker. GCP has no native deployment service, so gcpApply maps the
 * resource to a GCS REST call itself. Every phase is a modeled activity — boot,
 * build, apply, verify, teardown — with no raw shell.
 */
export default Op({
  name: "gcp",
  overview: "GCP: GCS bucket → floci-gcp (direct REST apply), local, no account",
  taskQueue: "trio-gcp",
  phases: [
    phase("Emulator", [flociGcpUp()]),
    phase("Build", [build(".", { script: "build:gcp" })]),
    phase("Apply", [gcpApply("dist/gcp.yaml", { endpoint: "http://localhost:4588", project: "local-project" })]),
    phase("Verify", [httpCheck("http://localhost:4588/storage/v1/b/trio-bucket")]),
    phase("Teardown", [flociGcpDown()]),
  ],
});
