import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gcp-basic-bucket",
  lexicon: "gcp",
  overview: "Build, deploy, and snapshot the GCP basic-bucket example.",
  context: [
    file("lexicons/gcp/examples/basic-bucket/src/infra.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/gcp/examples/basic-bucket && bun run build", { done: true }),
    task("Deploy: cd lexicons/gcp/examples/basic-bucket && kubectl apply -f config.yaml", { done: true }),
    task("State diff: cd lexicons/gcp/examples/basic-bucket && chant state diff local", { done: true }),
    task("State snapshot: cd lexicons/gcp/examples/basic-bucket && chant state snapshot local", { done: true }),
  ],
});
