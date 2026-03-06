import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-scheduled",
  lexicon: "aws",
  overview: "Build and verify the scheduled Lambda example using the LambdaScheduled composite.",
  context: [
    file("lexicons/aws/examples/lambda-scheduled/README.md"),
    file("lexicons/aws/examples/lambda-scheduled/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-scheduled && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-scheduled && bun run lint", { done: true }),
    task("Verify template.json contains 4 resources", { done: true }),
  ],
});
