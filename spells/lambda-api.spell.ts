import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-api",
  lexicon: "aws",
  overview: "Deploy the lambda-api example — three API endpoints with composites and scoped IAM policies.",
  context: [
    file("lexicons/aws/examples/lambda-api/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-api example at lexicons/aws/examples/lambda-api", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
