import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gcp-gke-cluster",
  lexicon: "gcp",
  overview: "Build, deploy, and snapshot the GCP gke-cluster example.",
  context: [
    file("lexicons/gcp/examples/gke-cluster/src/infra.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/gcp/examples/gke-cluster && bun run build", { done: true }),
    task("Deploy: cd lexicons/gcp/examples/gke-cluster && kubectl apply -f config.yaml", { done: true }),
    task("State diff: cd lexicons/gcp/examples/gke-cluster && chant state diff local", { done: true }),
    task("State snapshot: cd lexicons/gcp/examples/gke-cluster && chant state snapshot local", { done: true }),
  ],
});
