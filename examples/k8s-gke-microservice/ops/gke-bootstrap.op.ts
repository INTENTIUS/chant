import { Op, phase, shell } from "@intentius/chant/op";

export default Op({
  name: "gke-bootstrap",
  overview: "Bootstrap a GKE cluster with Config Connector for deploying GCP examples",
  phases: [
    phase("Bootstrap", [
      shell("GCP_PROJECT_ID=$GCP_PROJECT_ID npm run bootstrap", {
        cwd: "examples/k8s-gke-microservice",
      }),
    ]),
    phase("Verify", [
      shell("kubectl config current-context"),
      shell("kubectl get pods -n cnrm-system"),
    ]),
  ],
});
