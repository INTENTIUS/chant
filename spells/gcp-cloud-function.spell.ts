import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gcp-cloud-function",
  lexicon: "gcp",
  overview: "Build, deploy, and snapshot the GCP cloud-function example.",
  context: [
    file("lexicons/gcp/examples/cloud-function/src/infra.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/gcp/examples/cloud-function && bun run build", { done: true }),
    task("Deploy: cd lexicons/gcp/examples/cloud-function && kubectl apply -f config.yaml", { done: true }),
    task("State diff: cd lexicons/gcp/examples/cloud-function && chant state diff local", { done: true }),
    task("State snapshot: cd lexicons/gcp/examples/cloud-function && chant state snapshot local", { done: true }),
  ],
});
