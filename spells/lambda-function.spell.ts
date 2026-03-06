import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-function",
  lexicon: "aws",
  overview: "Build and verify the basic Lambda function example using the LambdaNode composite.",
  context: [
    file("lexicons/aws/examples/lambda-function/README.md"),
    file("lexicons/aws/examples/lambda-function/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-function && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-function && bun run lint", { done: true }),
    task("Verify template.json contains 2 resources", { done: true }),
  ],
});
