import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-dynamodb",
  lexicon: "aws",
  overview: "Build and verify the Lambda + DynamoDB example using the LambdaDynamoDB composite.",
  context: [
    file("lexicons/aws/examples/lambda-dynamodb/README.md"),
    file("lexicons/aws/examples/lambda-dynamodb/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-dynamodb && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-dynamodb && bun run lint", { done: true }),
    task("Verify template.json contains 3 resources", { done: true }),
  ],
});
