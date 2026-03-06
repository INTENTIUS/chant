import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-eventbridge",
  lexicon: "aws",
  overview: "Build and verify the Lambda + EventBridge example using the LambdaEventBridge composite.",
  context: [
    file("lexicons/aws/examples/lambda-eventbridge/README.md"),
    file("lexicons/aws/examples/lambda-eventbridge/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-eventbridge && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-eventbridge && bun run lint", { done: true }),
    task("Verify template.json contains 4 resources", { done: true }),
  ],
});
