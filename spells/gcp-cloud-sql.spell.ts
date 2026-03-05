import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gcp-cloud-sql",
  lexicon: "gcp",
  overview: "Build, deploy, and snapshot the GCP cloud-sql example.",
  context: [
    file("lexicons/gcp/examples/cloud-sql/src/infra.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/gcp/examples/cloud-sql && bun run build", { done: true }),
    task("Deploy: cd lexicons/gcp/examples/cloud-sql && kubectl apply -f config.yaml", { done: true }),
    task("State diff: cd lexicons/gcp/examples/cloud-sql && chant state diff local", { done: true }),
    task("State snapshot: cd lexicons/gcp/examples/cloud-sql && chant state snapshot local", { done: true }),
  ],
});
