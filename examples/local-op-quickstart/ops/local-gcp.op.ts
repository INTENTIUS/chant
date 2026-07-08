import { Op, phase, shell, build, gcpApply, gcpDelete } from "@intentius/chant-lexicon-temporal";

/**
 * Boot a local floci-gcp emulator, build a GCS bucket, apply it directly to the
 * emulator's GCS REST API, verify it exists, then tear the emulator down — the
 * first slice of chant's native GCP applier (#706 starter, #711).
 *
 * `chant run local-gcp` executes this in-process via the local executor. Requires
 * Docker + `curl`. Unlike Azure/CloudFormation, GCP has no native deployment
 * service to shell out to, so `gcpApply` maps each resource to a GCS REST call
 * itself, pointed at the emulator by `endpoint`. Currently handles StorageBucket.
 */
export default Op({
  name: "local-gcp",
  overview: "floci-gcp up → build bucket → gcpApply (REST) → verify → down",
  taskQueue: "local-gcp",
  phases: [
    phase("Emulator", [
      shell("docker run -d --rm --name chant-floci-gcp -p 4588:4588 floci/floci-gcp:latest"),
    ]),
    phase("Build", [
      build("lexicons/gcp/examples/basic-bucket"),
    ]),
    phase("Apply", [
      gcpApply("lexicons/gcp/examples/basic-bucket/config.yaml", {
        endpoint: "http://localhost:4588",
        project: "floci-local",
      }),
    ]),
    phase("Verify", [
      shell("curl -fs http://localhost:4588/storage/v1/b/my-data-bucket"),
    ]),
    phase("Delete", [
      gcpDelete("lexicons/gcp/examples/basic-bucket/config.yaml", {
        endpoint: "http://localhost:4588",
        project: "floci-local",
      }),
    ]),
    phase("Teardown", [
      shell("docker rm -f chant-floci-gcp"),
    ]),
  ],
});
