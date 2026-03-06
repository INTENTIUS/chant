import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-api",
  lexicon: "aws",
  overview: "Build and verify the Lambda API example — three API endpoints with composites, preset factories, scoped IAM policies, and a custom lint rule.",
  context: [
    file("lexicons/aws/examples/lambda-api/README.md"),
    file("lexicons/aws/examples/lambda-api/src/lambda-api.ts"),
    file("lexicons/aws/examples/lambda-api/src/health-api.ts"),
    file("lexicons/aws/examples/lambda-api/src/upload-api.ts"),
    file("lexicons/aws/examples/lambda-api/src/process-api.ts"),
    file("lexicons/aws/examples/lambda-api/src/data-bucket.ts"),
  ],
  tasks: [
    task("Build: cd lexicons/aws/examples/lambda-api && bun run build"),
    task("Lint: cd lexicons/aws/examples/lambda-api && bun run lint"),
    task("Verify template.json contains 10 resources"),
  ],
});
