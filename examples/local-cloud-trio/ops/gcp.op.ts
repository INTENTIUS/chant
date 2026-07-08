import { Op, phase, shell, gcpApply } from "@intentius/chant-lexicon-temporal";

/**
 * Deploy the GCS bucket to a local floci-gcp via `gcpApply`. `chant run gcp`.
 * Requires Docker + `curl`. GCP has no native deployment service, so gcpApply
 * maps the resource to a GCS REST call itself.
 */
export default Op({
  name: "gcp",
  overview: "GCP: GCS bucket → floci-gcp (direct REST apply), local, no account",
  taskQueue: "trio-gcp",
  phases: [
    phase("Emulator", [shell("docker run -d --rm --name trio-gcp -p 4588:4588 floci/floci-gcp:latest")]),
    phase("Build", [shell("npx chant build src/gcp --lexicon gcp -o dist/gcp.yaml")]),
    phase("Apply", [gcpApply("dist/gcp.yaml", { endpoint: "http://localhost:4588", project: "local-project" })]),
    phase("Verify", [shell("curl -fs http://localhost:4588/storage/v1/b/trio-bucket")]),
    phase("Teardown", [shell("docker rm -f trio-gcp")]),
  ],
});
