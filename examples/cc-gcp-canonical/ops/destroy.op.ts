import { Op, phase, gcpDelete } from "@intentius/chant-lexicon-temporal";

/** Tear the estate back down — the inverse of `deploy`. `chant run cc-gcp-destroy`. */
export default Op({
  name: "cc-gcp-destroy",
  overview: "GCP: delete the CC canonical estate from floci-gcp",
  taskQueue: "cc-gcp",
  phases: [
    phase("Destroy", [gcpDelete("dist/gcp.yaml", { endpoint: "http://localhost:4588", project: "local-project" })]),
  ],
});
