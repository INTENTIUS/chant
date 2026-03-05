import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gke-bootstrap",
  lexicon: "gcp",
  overview: "Bootstrap a GKE cluster with Config Connector for deploying GCP examples.",
  context: [
    file("examples/k8s-gke-microservice/scripts/bootstrap.sh"),
  ],
  tasks: [
    task("Run bootstrap: cd examples/k8s-gke-microservice && GCP_PROJECT_ID=lucid-volt-257820 npm run bootstrap", { done: true }),
    task("Verify kubectl context: kubectl config current-context", { done: true }),
    task("Verify Config Connector: kubectl get pods -n cnrm-system", { done: true }),
  ],
});
