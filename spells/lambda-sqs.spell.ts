import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-sqs",
  lexicon: "aws",
  overview: "Build and verify the Lambda + SQS example using the LambdaSqs composite.",
  context: [
    file("lexicons/aws/examples/lambda-sqs/README.md"),
    file("lexicons/aws/examples/lambda-sqs/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-sqs && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-sqs && bun run lint", { done: true }),
    task("Verify template.json contains 4 resources", { done: true }),
  ],
});
