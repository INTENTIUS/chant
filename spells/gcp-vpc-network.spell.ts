import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "gcp-vpc-network",
  lexicon: "gcp",
  overview: "Build, deploy, and snapshot the GCP vpc-network example.",
  context: [
    file("lexicons/gcp/examples/vpc-network/src/infra.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/gcp/examples/vpc-network && bun run build", { done: true }),
    task("Deploy: cd lexicons/gcp/examples/vpc-network && kubectl apply -f config.yaml", { done: true }),
    task("State diff: cd lexicons/gcp/examples/vpc-network && chant state diff local", { done: true }),
    task("State snapshot: cd lexicons/gcp/examples/vpc-network && chant state snapshot local", { done: true }),
  ],
});
