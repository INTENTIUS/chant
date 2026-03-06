import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-sns",
  lexicon: "aws",
  overview: "Build and verify the Lambda + SNS example using the LambdaSns composite.",
  context: [
    file("lexicons/aws/examples/lambda-sns/README.md"),
    file("lexicons/aws/examples/lambda-sns/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-sns && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-sns && bun run lint", { done: true }),
    task("Verify template.json contains 5 resources", { done: true }),
  ],
});
