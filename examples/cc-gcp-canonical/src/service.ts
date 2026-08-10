import { CloudRunService } from "@intentius/chant-lexicon-gcp";

// The workload half. floci-gcp emulates Cloud Run v2 (create/update are
// long-running operations the applier polls), so this is the closest thing to
// a running service the emulator can host — GKE stays out of this estate until
// the applier grows a ContainerCluster mapper (see test/gcp-cc-e2e.sh).
export const api = new CloudRunService({
  metadata: { name: "cc-gcp-api" },
  projectRef: { external: "local-project" },
  location: "us-central1",
  template: {
    containers: [{ image: "gcr.io/cloudrun/hello" }],
  },
});
