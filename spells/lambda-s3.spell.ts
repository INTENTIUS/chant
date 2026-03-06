import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-s3",
  lexicon: "aws",
  overview: "Build and verify the Lambda + S3 example using the LambdaS3 composite.",
  context: [
    file("lexicons/aws/examples/lambda-s3/README.md"),
    file("lexicons/aws/examples/lambda-s3/src/main.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-s3 && bun run build", { done: true }),
    task("Lint: cd lexicons/aws/examples/lambda-s3 && bun run lint", { done: true }),
    task("Verify template.json contains 3 resources", { done: true }),
  ],
});
